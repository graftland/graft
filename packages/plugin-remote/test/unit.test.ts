import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Ref,
	Sink,
	Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { RpcClient } from "effect/rpc"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Contract from "../src/Contract"
import { ProcessExited, TransportError } from "../src/Errors"
import localPlugin from "../src/host/local"
import workerPlugin from "../src/host/worker"
import {
	LocalTransport,
	WorkerTransport,
} from "../src/internal/directTransport"
import * as Unit from "../src/internal/unit"
import { api, contract, Value } from "./fixtures/unit-contract"

const runtime = Graft.layer.pipe(
	Layer.provideMerge(
		Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
	),
)
const setup = Effect.gen(function* () {
	const local = yield* Graft.plugin(localPlugin)
	const worker = yield* Graft.plugin(workerPlugin)
	yield* local.await
	yield* worker.await
	const found =
		yield* Deferred.make<Context.Context<LocalTransport | WorkerTransport>>()
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "unit-transports",
			inject: [LocalTransport, WorkerTransport],
			apply: () =>
				Effect.gen(function* () {
					const local = yield* LocalTransport
					const worker = yield* WorkerTransport
					yield* Deferred.succeed(
						found,
						Context.make(LocalTransport, local).pipe(
							Context.add(WorkerTransport, worker),
						),
					)
				}),
		}),
	)
	yield* consumer.await
	const transports = yield* Deferred.await(found)
	const fs = yield* FileSystem.FileSystem
	const root = yield* fs.makeTempDirectoryScoped({
		directory: new URL("../.cache", import.meta.url).pathname,
		prefix: "unit-",
	})
	const source = root + "/source"
	yield* fs.copy(
		new URL("../.cache/integration", import.meta.url).pathname,
		source,
	)
	yield* fs.writeFileString(source + "/package.json", '{"type":"module"}')
	const artifact = yield* Artifact.capture({
		directory: source,
		entry: "unit-plugin.js",
		store: root + "/store",
	})
	const contractModule = new URL(
		"../.cache/integration/unit-contract.js",
		import.meta.url,
	).href
	return { fs, source, artifact, contractModule, transports }
})
const input = (value: string) => ({ value, wait: false, hangStop: false })
for (const target of [
	{ _tag: "Worker", execArgv: [] },
	{ _tag: "Local" },
] as const) {
	it.live(
		`${target._tag} units describe their implementation and serve privately side by side`,
		() =>
			Effect.gen(function* () {
				const { fs, source, artifact, contractModule, transports } =
					yield* setup
				const starts = yield* Ref.make(0)
				yield* Graft.provide(Value, {
					read: Effect.succeed({ value: "host", probes: 0 }),
				})
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "host-consumer",
						inject: [Value],
						apply: () => Ref.update(starts, (n) => n + 1),
					}),
				)
				yield* consumer.await
				// A later edit to the original module must never be imported by either unit.
				yield* fs.writeFileString(
					source + "/unit-plugin.js",
					'throw new Error("source was imported")',
				)
				const open = Unit.open(contract, {
					artifact,
					contractModule,
					target,
				}).pipe(Effect.provideContext(transports))
				const first = yield* open
				const second = yield* open
				const description = yield* first.describe
				assert.equal(description.name, "actual-implementation")
				assert.isTrue(description.overlap)
				assert.deepEqual(description.provides, [
					{
						key: Value.key,
						operations: [{ name: "@graftland/test/unit/Read", version: 1 }],
					},
				])
				const observed1 = yield* first.exit
				assert.isTrue(Option.isNone(observed1))
				yield* first.serve(input("first"))
				yield* second.serve(input("second"))
				const observed2 = yield* first.ready
				assert.deepEqual(observed2, ["health", "broken"])
				yield* second.ready
				const client = (unit: typeof first) =>
					RpcClient.make(api).pipe(
						Effect.provideService(
							RpcClient.Protocol,
							unit.clientProtocol(Value.key),
						),
					)
				const a = yield* client(first)
				const b = yield* client(second)
				const observed3 = yield* a.Read()
				assert.deepEqual(observed3, { value: "first", probes: 0 })
				yield* first.probe("health")
				const observed4 = yield* a.Read()
				assert.deepEqual(observed4, { value: "first", probes: 1 })
				const observed5 = yield* b.Read()
				assert.deepEqual(observed5, { value: "second", probes: 0 })
				const broken = yield* Effect.flip(first.probe("broken"))
				assert.include(Cause.pretty(broken.cause), "unhealthy")
				assert.include(Cause.pretty(broken.cause), "probe defect")
				yield* first.stop
				const observed6 = yield* first.exit
				assert.isTrue(Option.isNone(observed6))
				const graceful = yield* first.terminate("graceful")
				assert.equal(graceful.exitCode, 0)
				const observed7 = yield* first.exit
				assert.isTrue(Option.isSome(observed7))
				const observed8 = yield* b.Read()
				assert.deepEqual(observed8, { value: "second", probes: 0 })
				const forced = yield* second.terminate("forced")
				const observed9 = yield* second.exit
				assert.isTrue(Option.isSome(observed9))
				const observed10 = yield* second.exited
				assert.deepEqual(observed10, forced)
				const observed11 = yield* Ref.get(starts)
				assert.equal(observed11, 1)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live(
		`${target._tag} serving returns before readiness and forced termination does not wait for cleanup`,
		() =>
			Effect.gen(function* () {
				const { artifact, contractModule, transports } = yield* setup
				const unit = yield* Unit.open(contract, {
					artifact,
					contractModule,
					target,
				}).pipe(Effect.provideContext(transports))
				yield* unit
					.serve({ ...input("waiting"), wait: true, hangStop: true })
					.pipe(Effect.timeout("3 seconds"))
				const ready = yield* unit.ready.pipe(Effect.forkScoped)
				const observed12 = yield* unit.exit
				assert.isTrue(Option.isNone(observed12))
				const stopping = yield* unit.stop.pipe(Effect.forkScoped)
				yield* unit.terminate("forced").pipe(Effect.timeout("3 seconds"))
				const observed13 = yield* unit.exit
				assert.isTrue(Option.isSome(observed13))
				const observed14 = yield* Fiber.await(ready)
				assert(Exit.isFailure(observed14))
				const observed15 = yield* Fiber.await(stopping)
				assert(Exit.isFailure(observed15))
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live(
		`${target._tag} describe does not echo the host's expected declarations`,
		() =>
			Effect.gen(function* () {
				const { artifact, contractModule, transports } = yield* setup
				const expected = Contract.make({
					name: "different-host-expectation",
					config: contract.config,
				})
				const unit = yield* Unit.open(expected, {
					artifact,
					contractModule,
					target,
				}).pipe(Effect.provideContext(transports))
				const observed16 = yield* unit.describe
				assert.equal(observed16.provides[0]?.key, Value.key)
				yield* unit.terminate("forced")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
}

it.live("transport loss is not exit evidence", () =>
	Effect.gen(function* () {
		const { artifact, contractModule } = yield* setup
		const observed = yield* Deferred.make<ProcessExited>()
		const lost = TransportError.make({
			cause: Cause.fail("channel lost without process exit"),
		})
		const status = ProcessExited.make({
			pid: Option.none(),
			exitCode: 0,
			stderr: "",
			statusCause: Cause.empty,
		})
		const unit = yield* Unit.open(contract, {
			artifact,
			contractModule,
			target: { _tag: "Worker" },
		}).pipe(
			Effect.provideService(WorkerTransport, {
				start: () =>
					Effect.succeed({
						pid: Option.none(),
						channel: { input: Stream.fail(lost), output: Sink.drain },
						failure: Effect.never,
						exited: Deferred.await(observed),
						terminate: Deferred.await(observed),
					}),
			}),
			Effect.provideService(LocalTransport, {
				start: () => Effect.die("Unexpected child launch"),
			}),
		)
		const failure = yield* Effect.flip(unit.failure)
		assert.equal(failure._tag, "RemoteError")
		const evidence = yield* unit.exit
		assert.isTrue(Option.isNone(evidence))
		const pending = yield* unit.exited.pipe(Effect.timeoutOption("20 millis"))
		assert.isTrue(Option.isNone(pending))
		// Only the simulated platform exit event supplies evidence, not the failed channel.
		yield* Deferred.succeed(observed, status)
		yield* unit.exited
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live("rejects a modified capture before launching a unit", () =>
	Effect.gen(function* () {
		const { fs, artifact, contractModule, transports } = yield* setup
		yield* fs.writeFileString(
			artifact.directory + "/unit-plugin.js",
			"tampered",
		)
		const failure = yield* Effect.flip(
			Unit.open(contract, {
				artifact,
				contractModule,
				target: { _tag: "Worker" },
			}).pipe(Effect.provideContext(transports)),
		)
		assert.equal(failure._tag, "ArtifactError")
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live(
	"reports implementation import and serving failures independently of describe",
	() =>
		Effect.gen(function* () {
			const { fs, source, artifact, contractModule, transports } = yield* setup
			const unit = yield* Unit.open(contract, {
				artifact,
				contractModule,
				target: { _tag: "Worker", execArgv: [] },
			}).pipe(Effect.provideContext(transports))
			yield* unit.describe
			yield* unit.serve(input("fail"))
			const failure = yield* Effect.flip(unit.ready)
			assert.include(Cause.pretty(failure.cause), "Serving failed")
			yield* unit.terminate("forced")
			yield* fs.writeFileString(
				source + "/unit-plugin.js",
				'throw new Error("Implementation import failed")',
			)
			const broken = yield* Artifact.capture({
				directory: source,
				entry: "unit-plugin.js",
				store: source + "-broken",
			})
			const other = yield* Unit.open(contract, {
				artifact: broken,
				contractModule,
				target: { _tag: "Worker", execArgv: [] },
			}).pipe(Effect.provideContext(transports))
			const imported = yield* Effect.flip(other.describe)
			assert.equal(imported._tag, "RemoteError")
			yield* other.terminate("forced")
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live(
	"readiness observes failure while an exported service is still missing",
	() =>
		Effect.gen(function* () {
			const { artifact, contractModule, transports } = yield* setup
			const unit = yield* Unit.open(contract, {
				artifact,
				contractModule,
				target: { _tag: "Worker", execArgv: [] },
			}).pipe(Effect.provideContext(transports))
			yield* unit.serve(input("missing"))
			const failure = yield* Effect.flip(
				unit.ready.pipe(Effect.timeout("2 seconds")),
			)
			assert.equal(failure._tag, "RemoteError")
			const observedFailure = yield* Effect.flip(unit.failure)
			assert.equal(observedFailure._tag, "RemoteError")
			yield* unit.terminate("forced")
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)
