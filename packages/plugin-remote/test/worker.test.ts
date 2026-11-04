import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Graft, Plugin, type Fork } from "@graftland/graft"
import {
	Array,
	Cause,
	Clock,
	Deferred,
	type Duration,
	Effect,
	Exit,
	FileSystem,
	Fiber,
	Layer,
	Option,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { Buffer } from "node:buffer"
import { MessageChannel } from "node:worker_threads"
import { expectTypeOf } from "vitest"
import process from "node:process"
import * as Remote from "../src/index"
import { executionPlugin } from "../src/internal/execution"
import worker from "../src/host/worker"
import {
	WorkerTransport,
	type Execution,
} from "../src/internal/directTransport"
import { LocalTerminationTimeout } from "../src/Errors"
import * as Channel from "../src/internal/workerChannel"
import { contract, ChildApi, HostApi } from "./fixtures/services-contract"
import { contract as handles } from "./fixtures/contract"

const runtime = Graft.layer.pipe(
	Layer.provideMerge(
		Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
	),
)
const servicesModule = new URL(
	"../.cache/integration/services-contract.js",
	import.meta.url,
).href
const handlesModule = new URL(
	"../.cache/integration/contract.js",
	import.meta.url,
).href

const transport = Effect.gen(function* () {
	const provider = yield* Graft.plugin(worker)
	yield* provider.await
	const found = yield* Deferred.make<typeof WorkerTransport.Service>()
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "worker-observer",
			inject: [WorkerTransport],
			apply: () =>
				WorkerTransport.pipe(
					Effect.flatMap((value) => Deferred.succeed(found, value)),
					Effect.asVoid,
				),
		}),
	)
	yield* consumer.await
	return yield* Deferred.await(found)
})
const launch = <C, I, E>(
	definition: Plugin.Plugin<C, I, E>,
	input: NoInfer<I>,
) =>
	Effect.gen(function* () {
		const original = yield* transport
		const execution = yield* Deferred.make<Execution>()
		const launched =
			yield* Deferred.make<Fork.Fork<C, E | Schema.SchemaError>>()
		const owner = yield* Graft.plugin(
			Plugin.make({
				name: "observed-worker",
				apply: () =>
					Effect.gen(function* () {
						yield* Graft.provide(WorkerTransport, {
							start: (options) =>
								original
									.start(options)
									.pipe(
										Effect.tap((value) => Deferred.succeed(execution, value)),
									),
						})
						const proxy = yield* Graft.plugin(definition, input)
						yield* proxy.await
						yield* Deferred.succeed(launched, proxy)
					}),
			}),
			undefined,
			{ isolate: [WorkerTransport] },
		)
		yield* owner.await
		return {
			proxy: yield* Deferred.await(launched),
			execution: yield* Deferred.await(execution),
		}
	})
const setup = (shutdownTimeout: Duration.Input = "5 seconds") =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped()
		yield* Graft.provide(HostApi, {
			double: (value) => Effect.succeed(value * 2),
		})
		const launched = yield* launch(
			executionPlugin(
				contract,
				{ contractModule: servicesModule, shutdownTimeout },
				{ _tag: "Worker", execArgv: [] },
			),
			{ directory, fail: false },
		)
		const captured = yield* Deferred.make<typeof ChildApi.Service>()
		const consumer = yield* Graft.plugin(
			Plugin.make({
				name: "worker-service-consumer",
				inject: [ChildApi],
				apply: () =>
					ChildApi.pipe(
						Effect.flatMap((api) => Deferred.succeed(captured, api)),
						Effect.asVoid,
					),
			}),
		)
		yield* consumer.await
		return { ...launched, fs, directory, api: yield* Deferred.await(captured) }
	})
const waitFile = (path: string) =>
	FileSystem.FileSystem.pipe(
		Effect.flatMap((fs) => fs.exists(path)),
		Effect.repeat({
			schedule: Schedule.spaced("10 millis"),
			until: (found) => found,
		}),
	)
describe("direct worker execution", () => {
	it.live(
		"calls a cross-boundary service at generation one and confirms exit after Dispose",
		() =>
			Effect.gen(function* () {
				const { proxy, execution, api, fs, directory } = yield* setup()
				const result = yield* api.call(20)
				assert.equal(result.value, 41)
				assert.equal(result.generation, 1)
				assert.equal(result.pid, process.pid)
				assert.isTrue(Option.isNone(execution.pid))
				assert.isAbove(execution.threadId ?? -1, 0)
				yield* proxy.dispose
				const status = yield* execution.exited
				assert.equal(status.exitCode, 0)
				assert.equal(status.threadId, execution.threadId)
				assert.isEmpty(status.statusCause.reasons)
				const finalized = yield* fs.exists(
					directory + "/finalized-" + process.pid,
				)
				assert.isTrue(finalized)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		"terminates and observes a worker whose plugin thread ignores Dispose",
		() =>
			Effect.gen(function* () {
				const { proxy, execution, api, directory } = yield* setup("100 millis")
				yield* api.call(-999).pipe(Effect.exit, Effect.forkScoped)
				yield* waitFile(directory + "/blocked")
				const result = yield* proxy.dispose.pipe(
					Effect.exit,
					Effect.timeout("5 seconds"),
				)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result))
					assert.include(Cause.pretty(result.cause), "Timeout")
				const status = yield* execution.exited
				assert.equal(status.exitCode, 1)
				assert.equal(status.threadId, execution.threadId)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		"bounds exit after successful Dispose when a worker retains a Node handle",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				yield* fs.writeFileString(directory + "/release", "ready")
				const { proxy, execution } = yield* launch(
					executionPlugin(
						handles,
						{ contractModule: handlesModule },
						{ _tag: "Worker" },
					),
					{ directory, mode: "leaked-handle", value: 1 },
				)
				const before = yield* Clock.currentTimeMillis
				const result = yield* proxy.dispose.pipe(
					Effect.exit,
					Effect.timeout("5 seconds"),
				)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result))
					assert.isTrue(
						Array.some(
							result.cause.reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Array.some(
									reason.error.cause.reasons,
									(inner) =>
										inner._tag === "Die" &&
										Schema.is(LocalTerminationTimeout)(inner.defect) &&
										inner.defect.threadId === execution.threadId &&
										inner.defect.pid === undefined,
								),
						),
					)
				const elapsed = (yield* Clock.currentTimeMillis) - before
				assert.isAtLeast(elapsed, 1000)
				const status = yield* execution.exited
				assert.equal(status.exitCode, 1)
				const finalized = yield* fs.exists(
					directory + "/finalized-" + process.pid,
				)
				assert.isTrue(finalized)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
	it.live(
		"transfers copied buffers without detaching the caller's pooled or shared storage",
		() =>
			Effect.gen(function* () {
				const ports = yield* Effect.acquireRelease(
					Effect.sync(() => new MessageChannel()),
					(ports) =>
						Effect.sync(() => {
							ports.port1.close()
							ports.port2.close()
						}),
				)
				const sender = yield* Channel.make(ports.port1)
				const receiver = yield* Channel.make(ports.port2)
				const pooled = Buffer.from([1, 2, 3, 4])
				const shared = new Uint8Array(new SharedArrayBuffer(4))
				shared.set([5, 6, 7, 8])
				const size = pooled.buffer.byteLength
				yield* Stream.make(pooled.subarray(1, 3), shared.subarray(1, 3)).pipe(
					Stream.run(sender.output),
				)
				const received = yield* Stream.runCollect(receiver.input)
				assert.deepEqual(
					Array.map(received, (bytes) => Array.fromIterable(bytes)),
					[
						[2, 3],
						[6, 7],
					],
				)
				assert.equal(pooled.buffer.byteLength, size)
				assert.deepEqual(Array.fromIterable(pooled), [1, 2, 3, 4])
				assert.deepEqual(Array.fromIterable(shared), [5, 6, 7, 8])
			}).pipe(Effect.scoped),
	)
	it.live("sends EOF when the output writer is interrupted", () =>
		Effect.gen(function* () {
			const ports = yield* Effect.acquireRelease(
				Effect.sync(() => new MessageChannel()),
				(ports) =>
					Effect.sync(() => {
						ports.port1.close()
						ports.port2.close()
					}),
			)
			const sender = yield* Channel.make(ports.port1)
			const receiver = yield* Channel.make(ports.port2)
			const writing = yield* Stream.succeed(new Uint8Array([42])).pipe(
				Stream.concat(Stream.never),
				Stream.run(sender.output),
				Effect.forkScoped,
			)
			const first = yield* Stream.runHead(receiver.input)
			assert.isTrue(Option.isSome(first))
			yield* Fiber.interrupt(writing)
			yield* Stream.runDrain(receiver.input).pipe(Effect.timeout("1 second"))
		}).pipe(Effect.scoped),
	)

	it("does not accept authentication on a worker target", () => {
		expectTypeOf<
			Extract<Remote.Connect, { worker: object }>["auth"]
		>().toEqualTypeOf<undefined>()
	})
})
