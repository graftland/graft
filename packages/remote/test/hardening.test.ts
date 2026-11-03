import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Graft } from "@graftland/graft"
import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Logger,
	Option,
	PlatformError,
	Ref,
	Schema,
	Scope,
	Stream,
	String,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient } from "effect/rpc"
import process from "node:process"
import { fileURLToPath } from "node:url"
import * as Remote from "../src/index"
import { cleanupCause } from "../src/internal/cleanup"
import { Control } from "../src/internal/control"
import * as Transport from "../src/internal/transport"
import { contract, Rejected } from "./fixtures/contract"

const contractModule = new URL(
	"../.cache/integration/contract.js",
	import.meta.url,
).href
const runtime = Layer.provideMerge(Graft.layer, NodeServices.layer)
const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped()
	yield* fs.writeFileString(`${directory}/release`, "release")
	return { fs, directory }
})
const spy = Effect.gen(function* () {
	const calls = yield* Ref.make(0)
	const error = PlatformError.badArgument({
		module: "RemoteTest",
		method: "spawn",
		description: "Host spawner sentinel",
	})
	const spawner = ChildProcessSpawner.make(() =>
		Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(Effect.fail(error))),
	)
	const layer = Layer.provideMerge(
		Graft.layer,
		Layer.merge(
			NodeServices.layer,
			Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
		),
	)
	return { calls, error, layer }
})

class Marker extends Context.Service<Marker, string>()(
	"@graftland/remote/test/hardening.test/Marker",
) {}

describe("local remote hardening", () => {
	it.live("uses the spawner supplied to the host Graft layer", () =>
		Effect.gen(function* () {
			const { calls, error, layer } = yield* spy
			const exit = yield* Effect.gen(function* () {
				const fork = yield* Graft.plugin(
					Remote.plugin(contract, { contractModule }),
					{ directory: "unused", mode: "normal", value: 1 },
				)
				return yield* Effect.exit(fork.await)
			}).pipe(Effect.scoped, Effect.provide(layer))
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.isTrue(
					Array.some(
						exit.cause.reasons,
						(reason) => reason._tag === "Fail" && reason.error === error,
					),
				)
			const count = yield* Ref.get(calls)
			assert.equal(count, 1)
		}),
	)

	it.live(
		"rejects a Type-side refinement as SchemaError without spawning",
		() =>
			Effect.gen(function* () {
				const { calls, layer } = yield* spy
				const refined = Remote.Contract.make({
					...contract,
					config: Schema.FiniteFromString.check(Schema.isGreaterThan(0)),
				})
				const exit = yield* Effect.gen(function* () {
					const fork = yield* Graft.plugin(
						Remote.plugin(refined, { contractModule }),
						"-1",
					)
					return yield* Effect.exit(fork.await)
				}).pipe(Effect.scoped, Effect.provide(layer))
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.isTrue(
						Array.some(
							exit.cause.reasons,
							(reason) =>
								reason._tag === "Fail" && Schema.isSchemaError(reason.error),
						),
					)
				const count = yield* Ref.get(calls)
				assert.equal(count, 0)
			}),
	)

	it("flattens Fail into Die while retaining reason annotations and interrupts", () => {
		const failure = Cause.makeFailReason("cleanup failure").annotate(
			Context.make(Marker, "failure"),
		)
		const defect = Cause.makeDieReason(new Error("cleanup defect")).annotate(
			Context.make(Marker, "defect"),
		)
		const interrupt = Cause.makeInterruptReason(42).annotate(
			Context.make(Marker, "interrupt"),
		)
		const converted = cleanupCause(
			Cause.fromReasons([failure, defect, interrupt]),
		)
		assert.deepEqual(
			Array.map(converted.reasons, (reason) => reason._tag),
			["Die", "Die", "Interrupt"],
		)
		assert.deepEqual(
			Array.map(converted.reasons, (reason) =>
				Context.getOrUndefined(Cause.reasonAnnotations(reason), Marker),
			),
			["failure", "defect", "interrupt"],
		)
		assert.equal(converted.reasons[1], defect)
		assert.equal(converted.reasons[2], interrupt)
		assert.isTrue(
			converted.reasons[0]?._tag === "Die" &&
				converted.reasons[0].defect === "cleanup failure",
		)
	})

	it.live(
		"loads a default-export contract with the packaged generic runner",
		() =>
			Effect.gen(function* () {
				const { fs, directory } = yield* setup
				const fork = yield* Graft.plugin(
					Remote.plugin(contract, {
						contractModule: new URL(
							"../.cache/integration/default-contract.js",
							import.meta.url,
						).href,
					}),
					{ directory, mode: "normal", value: 3 },
				)
				yield* fork.await
				yield* fork.dispose
				const names = yield* fs.readDirectory(directory)
				assert.isTrue(
					Array.some(names, (name) => String.startsWith("finalized-")(name)),
				)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live(
		"reports an invalid contract module through child exit diagnostics",
		() =>
			Effect.gen(function* () {
				const { directory } = yield* setup
				const fork = yield* Graft.plugin(
					Remote.plugin(contract, { contractModule: "node:path" }),
					{ directory, mode: "normal", value: 1 },
				)
				const exit = yield* Effect.exit(fork.await)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.isTrue(
						Array.some(
							exit.cause.reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(Remote.ProcessExited)(reason.error) &&
								reason.error.exitCode !== 0 &&
								String.includes("No remote contract exported")(
									reason.error.stderr,
								),
						),
					)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)

	it.live(
		"forwards flood loss counts to host logs and completes disposal",
		() =>
			Effect.gen(function* () {
				const { directory } = yield* setup
				const fork = yield* Graft.plugin(
					Remote.plugin(contract, { contractModule }),
					{ directory, mode: "flood", value: 1 },
				)
				yield* fork.await
				yield* fork.dispose.pipe(Effect.timeout("5 seconds"))
				const entry = yield* Graft.logs.pipe(
					Stream.filter(
						(entry) =>
							typeof entry.annotations["remote.logs.droppedTotal"] === "number",
					),
					Stream.runHead,
					Effect.timeout("2 seconds"),
				)
				const log = Option.getOrThrow(entry)
				assert.equal(log.annotations["graft.fork"], fork.id)
				assert.isAbove(Number(log.annotations["remote.logs.droppedTotal"]), 0)
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(runtime, Logger.layer([]))),
			),
	)

	it.live(
		"delivers Failed and Stopped while logs are backpressured and counts every dropped log",
		() =>
			Effect.gen(function* () {
				const { fs, directory } = yield* setup
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const scope = yield* Effect.scope
				const processScope = yield* Scope.fork(scope)
				const child = yield* spawner
					.spawn(
						ChildProcess.make(
							process.execPath,
							[
								fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
								contractModule,
							],
							{
								stdin: "pipe",
								stdout: "pipe",
								stderr: "pipe",
								additionalFds: { fd3: { type: "output" } },
								forceKillAfter: "1 second",
							},
						),
					)
					.pipe(Scope.provide(processScope))
				const transport = yield* Transport.make(child)
				const client = yield* RpcClient.make(Control).pipe(
					Effect.provideService(RpcClient.Protocol, transport.protocol),
				)
				const releaseLogs = yield* Deferred.make<void>()
				const receivedLog = yield* Deferred.make<void>()
				const count = yield* Ref.make(0)
				const totalDropped = yield* Ref.make(0)
				const logFiber = yield* client.Logs().pipe(
					Stream.runForEach((event) =>
						Effect.gen(function* () {
							yield* Ref.set(totalDropped, event.dropped)
							if (event._tag === "Log") {
								yield* Ref.update(count, (n) => n + 1)
								yield* Deferred.succeed(receivedLog, undefined)
								yield* Deferred.await(releaseLogs)
							}
						}),
					),
					Effect.forkScoped,
				)
				const stopped = yield* Deferred.make<void>()
				const failed =
					yield* Deferred.make<
						Cause.Cause<Rejected | Remote.Contract.UndeclaredFailure>
					>()
				yield* client.Events().pipe(
					Stream.runForEach((event) =>
						Effect.gen(function* () {
							if (event._tag === "Stopped")
								yield* Deferred.succeed(stopped, undefined)
							else if (event._tag === "Failed") {
								const cause = yield* contract.decodeCause(event.cause)
								yield* Deferred.succeed(failed, cause)
							}
						}),
					),
					Effect.forkScoped,
				)
				const loaded = yield* client.Load({
					input: { directory, mode: "flood", value: 2 },
				})
				assert.equal(loaded._tag, "Success")
				yield* Deferred.await(receivedLog)
				yield* fs.writeFileString(`${directory}/fail`, "fail")
				const failure = yield* Deferred.await(failed).pipe(
					Effect.timeout("2 seconds"),
				)
				assert.isTrue(
					Array.some(
						failure.reasons,
						(reason) =>
							reason._tag === "Fail" && Schema.is(Rejected)(reason.error),
					),
				)
				const disposed = yield* client
					.Dispose()
					.pipe(Effect.timeout("2 seconds"))
				assert.equal(disposed._tag, "Success")
				yield* Deferred.await(stopped).pipe(Effect.timeout("2 seconds"))
				assert.isTrue(logFiber.pollUnsafe() === undefined)
				yield* Deferred.succeed(releaseLogs, undefined)
				yield* Fiber.join(logFiber)
				const delivered = yield* Ref.get(count)
				const dropped = yield* Ref.get(totalDropped)
				assert.isAbove(dropped, 0)
				// Two bursts, startup/finalizer messages, and Graft's terminal failure log.
				assert.equal(delivered + dropped, 8195)
				yield* Ref.set(transport.stopping, true)
				yield* transport.end
				const status = yield* Fiber.join(transport.exited)
				assert.equal(status.exitCode, 0)
				yield* Scope.close(processScope, Exit.void)
				assert.throws(() => process.kill(child.pid, 0))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
