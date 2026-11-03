import { assert, describe, it } from "@effect/vitest"
import { inject } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Option,
	Exit,
	Fiber,
	FiberSet,
	FileSystem,
	Layer,
	Redacted,
	Ref,
	Schema,
	Schedule,
	Stream,
	String,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import process from "node:process"
import * as Remote from "../src/index"
import { RpcClient } from "effect/rpc"
import * as Port from "../src/internal/port"
import * as Multiplex from "../src/internal/runner/Multiplex"
import * as Tls from "../src/internal/runner/Tls"
import * as Wire from "../src/internal/runner/Wire"
import * as Model from "../src/internal/runner/model"
import * as Processes from "../src/internal/runner/Processes"
import { tcpProxy } from "./network-proxy"
import { command } from "../src/internal/runner/command"
import { ChildApi, HostApi, contract } from "./fixtures/services-contract"

declare module "vitest" {
	export interface ProvidedContext {
		remoteRoot: string
	}
}
const credentials = (name: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = inject("remoteTls")
		const key = yield* fs.readFileString(directory + "/" + name + ".key")
		return {
			key: Redacted.make(key),
			cert: yield* fs.readFileString(directory + "/" + name + ".crt"),
			ca: yield* fs.readFileString(directory + "/ca.crt"),
			servername: "localhost",
		}
	})
const runtime = Layer.provideMerge(Graft.layer, NodeServices.layer)
const startRunner = (state: string, lease = 15000) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const certs = inject("remoteTls")
		const argv = yield* command()
		const child = yield* spawner.spawn(
			ChildProcess.make(
				argv[0],
				[
					argv[1]!,
					"serve",
					"--host",
					"127.0.0.1",
					"--port",
					"0",
					"--state",
					state,
					"--root",
					inject("remoteRoot"),
					"--cert",
					certs + "/server.crt",
					"--key",
					certs + "/server.key",
					"--ca",
					certs + "/ca.crt",
					"--lease",
					`${lease}`,
					"--grace",
					"5000",
				],
				{
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					forceKillAfter: "2 seconds",
				},
			),
		)
		const readers = yield* FiberSet.make<void, never>()
		const ready = yield* Deferred.make<number>()
		const stderr = yield* Ref.make("")
		yield* child.stderr.pipe(
			Stream.decodeText(),
			Stream.runForEach((text) =>
				Ref.update(stderr, (tail) => String.takeRight(tail + text, 8192)).pipe(
					Effect.asVoid,
				),
			),
			Effect.orDie,
			Effect.asVoid,
			FiberSet.run(readers),
		)
		yield* child.stdout.pipe(
			Stream.decodeText(),
			Stream.splitLines,
			Stream.runForEach((line) =>
				String.startsWith("{")(line)
					? Schema.decodeEffect(
							Schema.fromJsonString(
								Schema.Struct({
									event: Schema.Literal("Listening"),
									port: Schema.Int,
								}),
							),
						)(line).pipe(
							Effect.flatMap((message) =>
								Deferred.succeed(ready, message.port),
							),
						)
					: Effect.void,
			),
			Effect.orDie,
			Effect.asVoid,
			FiberSet.run(readers),
		)
		const port = yield* Effect.raceFirst(
			Deferred.await(ready),
			child.exitCode.pipe(
				Effect.flatMap((code) =>
					Ref.get(stderr).pipe(
						Effect.flatMap((tail) =>
							Effect.die(
								new Error(
									"Runner exited before listening: " + code + " " + tail,
								),
							),
						),
					),
				),
			),
		).pipe(
			Effect.raceFirst(
				FiberSet.join(readers).pipe(Effect.andThen(Effect.never)),
			),
			Effect.timeout("30 seconds"),
		)
		return { child, port, stderr }
	})
const setup = (lease = 15000, partitionable = false) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped()
		const daemon = yield* startRunner(directory + "/state", lease)
		const provider = yield* Graft.plugin(
			Plugin.make({
				name: "network-host-provider",
				apply: () =>
					Graft.provide(HostApi, { double: (n) => Effect.succeed(n * 2) }),
			}),
		)
		yield* provider.await
		const proxySocket = partitionable ? yield* tcpProxy(daemon.port) : undefined
		const target = Remote.runner({
			host: "127.0.0.1",
			port: proxySocket?.port ?? daemon.port,
			tls: yield* credentials("client"),
			lease,
			margin: "1 second",
		})
		const proxy = yield* Graft.plugin(
			Remote.plugin(contract, {
				contractModule: "remote-fixture",
				instance: "worker",
				target,
			}),
			{ directory, fail: false },
		)
		yield* proxy.await.pipe(Effect.timeout("30 seconds"))
		const service = yield* Deferred.make<ChildApi["Service"]>()
		const consumer = yield* Graft.plugin(
			Plugin.make({
				name: "network-host-consumer",
				inject: [ChildApi],
				apply: () =>
					Effect.gen(function* () {
						const api = yield* ChildApi
						yield* Deferred.succeed(service, api)
					}),
			}),
		)
		yield* consumer.await
		return {
			...daemon,
			proxySocket,
			fs,
			directory,
			proxy,
			api: yield* Deferred.await(service),
			target,
		}
	})

const control = (port: number, name = "client") =>
	Effect.gen(function* () {
		const socket = yield* Tls.connect({
			host: "127.0.0.1",
			port,
			tls: yield* credentials(name),
			servername: "localhost",
		})
		const mux = yield* Multiplex.fromSocket(socket)
		const peer = yield* Port.make(Wire.channel(mux, 0), {
			session: "session-v1",
			serve: {},
			call: { session: Wire.Session },
		})
		return yield* RpcClient.make(Wire.Session).pipe(
			Effect.provideService(RpcClient.Protocol, peer.clientProtocol("session")),
		)
	})
const until = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	predicate: (value: A) => boolean,
) =>
	effect.pipe(
		Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: predicate }),
		Effect.timeout("30 seconds"),
	)
const gone = (pid: number) =>
	until(
		Effect.sync(() => {
			try {
				process.kill(pid, 0)
				return false
			} catch {
				return true
			}
		}),
		(value) => value,
	)
const latestRecord = (state: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const files = yield* fs.readDirectory(state)
		const records = yield* Effect.forEach(
			Array.filter(files, String.endsWith(".json")),
			(file) =>
				fs
					.readFileString(state + "/" + file)
					.pipe(
						Effect.flatMap(
							Schema.decodeEffect(
								Schema.fromJsonString(Schema.toCodecJson(Model.SessionRecord)),
							),
						),
					),
		)
		assert.lengthOf(records, 1)
		return records[0]!
	})

describe("network runner end to end", () => {
	it.live(
		"runs a preinstalled plugin through mTLS with bidirectional services and confirmed graceful exit",
		() =>
			Effect.gen(function* () {
				const { api, proxy, fs, directory } = yield* setup()
				const reply = yield* api.call(20)
				assert.equal(reply.value, 41)
				assert.equal(reply.id, "worker")
				assert.equal(reply.generation, 1)
				assert.notEqual(reply.pid, process.pid)
				const values = yield* api.values.pipe(Stream.take(3), Stream.runCollect)
				assert.deepEqual(values, [0, 1, 2])
				yield* until(fs.exists(directory + "/stream-ended"), (exists) => exists)
				const held = yield* Effect.forkScoped(api.hold)
				yield* until(fs.exists(directory + "/holding"), (exists) => exists)
				yield* Fiber.interrupt(held)
				yield* until(fs.exists(directory + "/hold-ended"), (exists) => exists)

				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "network-draining-consumer",
						inject: [ChildApi],
						apply: () =>
							Effect.gen(function* () {
								const service = yield* ChildApi
								yield* Effect.addFinalizer(() =>
									Effect.gen(function* () {
										const response = yield* service.call(41)
										assert.equal(response.value, 83)
										yield* Deferred.succeed(entered, undefined)
										yield* Deferred.await(release)
									}),
								)
							}),
					}),
				)
				yield* consumer.await
				const disposing = yield* Effect.forkScoped(proxy.dispose)
				yield* Deferred.await(entered)
				assert.isUndefined(disposing.pollUnsafe())
				assert.doesNotThrow(() => process.kill(reply.pid, 0))
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(disposing)
				const finalized = yield* fs.exists(
					directory + "/finalized-" + reply.pid,
				)
				assert.isTrue(finalized)
				assert.throws(() => process.kill(reply.pid, 0))
				const record = yield* latestRecord(directory + "/state")
				assert.equal(
					record.phase === "Stopped" ? record.termination.kind : undefined,
					"Exited",
					record.phase === "Stopped"
						? record.termination.exit.stderr
						: undefined,
				)
				assert.equal(
					record.phase === "Stopped" ? record.termination.exit.code : undefined,
					0,
				)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		90_000,
	)
	it.live(
		"reports unconfirmed termination after a partition while the runner reclaims its child",
		() =>
			Effect.gen(function* () {
				const result = yield* Effect.exit(
					Effect.gen(function* () {
						const { api, proxy, proxySocket } = yield* setup(10000, true)
						const reply = yield* api.call(1)
						const started = yield* Effect.sync(() => performance.now())
						yield* proxySocket!.disconnect
						const disposed = yield* Effect.exit(proxy.dispose)
						const elapsed = yield* Effect.sync(
							() => performance.now() - started,
						)
						assert.isTrue(Exit.isFailure(disposed))
						if (Exit.isFailure(disposed))
							assert.include(
								Cause.pretty(disposed.cause),
								"RemoteTerminationUnconfirmed",
							)
						assert.isAtLeast(elapsed, 11000)
						yield* gone(reply.pid)
					}).pipe(Effect.scoped, Effect.provide(runtime)),
				)
				assert.isTrue(Exit.isSuccess(result))
				if (Exit.isFailure(result))
					assert.include(
						Cause.pretty(result.cause),
						"RemoteTerminationUnconfirmed",
					)
			}),
		90_000,
	)
	it.live(
		"kills a blocked plugin through its watchdog when the runner is killed",
		() =>
			Effect.gen(function* () {
				const result = yield* Effect.exit(
					Effect.gen(function* () {
						const { api, proxy, child, fs, directory } = yield* setup(15000)
						const reply = yield* api.call(0)
						const blocked = yield* Effect.forkScoped(api.call(-999))
						yield* until(fs.exists(directory + "/blocked"), (exists) => exists)
						yield* Effect.sync(() => process.kill(child.pid, "SIGKILL"))
						yield* gone(reply.pid)
						yield* Fiber.interrupt(blocked)
						yield* proxy.dispose
					}).pipe(Effect.scoped, Effect.provide(runtime)),
				)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result))
					assert.include(
						Cause.pretty(result.cause),
						"RemoteTerminationUnconfirmed",
					)
			}),
		90_000,
	)
	it.live(
		"renews a live child and enforces its lease even while the runner is suspended",
		() =>
			Effect.gen(function* () {
				const result = yield* Effect.exit(
					Effect.gen(function* () {
						const { api, child, fs, directory, proxy } = yield* setup(10000)
						yield* Effect.sleep("12 seconds")
						const reply = yield* api.call(2)
						assert.equal(reply.value, 5)
						const blocked = yield* Effect.forkScoped(api.call(-999))
						yield* until(fs.exists(directory + "/blocked"), (exists) => exists)
						const record = yield* latestRecord(directory + "/state")
						yield* Effect.acquireRelease(
							Effect.sync(() => process.kill(child.pid, "SIGSTOP")),
							() => Effect.sync(() => process.kill(child.pid, "SIGCONT")),
						).pipe(
							Effect.andThen(
								until(
									Processes.matches(Option.getOrThrow(Model.childOf(record))),
									(alive) => !alive,
								),
							),
							Effect.scoped,
						)
						yield* gone(reply.pid)
						yield* Fiber.interrupt(blocked)
						yield* proxy.dispose
					}).pipe(Effect.scoped, Effect.provide(runtime)),
				)
				// A blocked business call fails when the resumed runner reports the expired session.
				if (Exit.isFailure(result))
					assert.isTrue(
						Array.every(
							result.cause.reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(Schema.TaggedStruct("CleanupError", {}))(
									reason.error,
								),
						),
					)
			}),
		120_000,
	)

	it.live(
		"serializes generations through confirmed process exit and rejects stale or expired sessions",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const daemon = yield* startRunner(directory + "/state")
				const first = yield* control(daemon.port)
				const opened = yield* first.Open({
					instance: "serial",
					requestId: "first",
					expectedGeneration: null,
					limits: Model.defaults,
				})
				yield* first.Load({
					handle: opened.handle,
					specifier: "remote-fixture",
				})
				const loaded = yield* first.Status(opened.handle)
				assert.isTrue(Option.isSome(Model.childOf(loaded)))
				const pid = Option.getOrThrow(Model.childOf(loaded)).pid
				yield* Effect.sync(() => process.kill(pid, "SIGSTOP"))
				const disposed = yield* Effect.forkScoped(first.Dispose(opened.handle))
				const second = yield* control(daemon.port)
				const replacing = yield* Effect.forkScoped(
					second.Open({
						instance: "serial",
						requestId: "second",
						expectedGeneration: 1,
						limits: Model.defaults,
					}),
				)
				yield* until(
					first.Status(opened.handle),
					(record) => record.phase === "Stopping",
				)
				assert.isUndefined(replacing.pollUnsafe())
				const termination = yield* Fiber.join(disposed)
				assert.equal(termination.kind, "Killed")
				const replacement = yield* Fiber.join(replacing)
				assert.equal(replacement.handle.generation, 2)
				yield* gone(pid)
				const stale = yield* Effect.exit(first.Renew(opened.handle))
				assert.isTrue(Exit.isFailure(stale))
				if (Exit.isFailure(stale))
					assert.include(Cause.pretty(stale.cause), "Unknown session")
				yield* second.Dispose(replacement.handle)
				const expiring = yield* first.Open({
					instance: "expiring",
					requestId: "expire",
					expectedGeneration: null,
					limits: Model.defaults,
					leaseMillis: 1000,
				})
				yield* until(
					first.Status(expiring.handle),
					(record) => record.phase === "Stopped",
				)
				const late = yield* Effect.exit(first.Renew(expiring.handle))
				assert.isTrue(Exit.isFailure(late))
				if (Exit.isFailure(late))
					assert.include(Cause.pretty(late.cause), "expired")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		90_000,
	)
	it.live(
		"recovers a real stopped orphan before reopening its key and never signals a mismatched identity",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const state = directory + "/state"
				const daemon = yield* startRunner(state)
				const client = yield* control(daemon.port)
				const opened = yield* client.Open({
					instance: "recover",
					requestId: "first",
					expectedGeneration: null,
					limits: Model.defaults,
				})
				yield* client.Load({
					handle: opened.handle,
					specifier: "remote-fixture",
				})
				const loaded = yield* client.Status(opened.handle)
				const identity = Option.getOrThrow(Model.childOf(loaded))
				yield* Effect.addFinalizer(() =>
					Processes.recover(identity).pipe(Effect.orDie),
				)
				yield* Effect.sync(() => process.kill(identity.pid, "SIGSTOP"))
				yield* Effect.sync(() => process.kill(daemon.child.pid, "SIGKILL"))
				const restarted = yield* startRunner(state)
				yield* gone(identity.pid)
				const next = yield* control(restarted.port)
				const generation = yield* next.HighWater({ instance: "recover" })
				assert.equal(generation, 1)
				const replacement = yield* next.Open({
					instance: "recover",
					requestId: "second",
					expectedGeneration: generation,
					limits: Model.defaults,
				})
				assert.equal(replacement.handle.generation, 2)
				const mismatch = yield* Processes.recover({
					pid: process.pid,
					start: { born: "different-start", nonce: "different-command" },
				})
				assert.equal(mismatch.kind, "Exited")
				const own = yield* Processes.identity(process.pid, process.argv[1]!)
				const ambiguous = yield* Effect.exit(
					Processes.recover({
						...own,
						start: {
							...own.start,
							nonce: "missing-bootstrap-nonce",
						},
					}),
				)
				assert.isTrue(Exit.isFailure(ambiguous))
				if (Exit.isFailure(ambiguous))
					assert.include(
						Cause.pretty(ambiguous.cause),
						"bootstrap nonce is missing",
					)
				assert.doesNotThrow(() => process.kill(process.pid, 0))
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		90_000,
	)
	it.live(
		"rejects a second runner owning the state directory and unauthenticated TLS peers",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const daemon = yield* startRunner(directory + "/state")
				const locked = yield* Effect.exit(startRunner(directory + "/state"))
				assert.isTrue(Exit.isFailure(locked))
				if (Exit.isFailure(locked))
					assert.include(Cause.pretty(locked.cause), "already owned")
				const rejected = yield* Effect.exit(
					Effect.scoped(
						Effect.gen(function* () {
							const client = yield* control(daemon.port, "rogue")
							yield* client.HighWater({ instance: "untrusted" })
						}),
					),
				)
				assert.isTrue(Exit.isFailure(rejected))
				const client = yield* control(daemon.port)
				const generation = yield* client.HighWater({ instance: "untrusted" })
				assert.isNull(generation)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		90_000,
	)
	it.live(
		"rejects missing instance ids and package pins before the implementation applies",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const daemon = yield* startRunner(directory + "/state")
				const provider = yield* Graft.plugin(
					Plugin.make({
						name: "pin-host-provider",
						apply: () => Graft.provide(HostApi, { double: Effect.succeed }),
					}),
				)
				yield* provider.await
				for (const [index, expect] of [
					{ version: "wrong" },
					{ digest: "wrong" },
					undefined,
				].entries()) {
					const proxy = yield* Graft.plugin(
						Remote.plugin(contract, {
							contractModule: "remote-fixture",
							...(expect === undefined ? {} : { instance: "pin-" + index }),
							target: Remote.runner({
								host: "127.0.0.1",
								port: daemon.port,
								tls: yield* credentials("client"),
								...(expect === undefined ? {} : { expect }),
							}),
						}),
						{ directory, fail: false },
					)
					const failed = yield* Effect.exit(proxy.await)
					assert.isTrue(Exit.isFailure(failed))
					if (Exit.isFailure(failed))
						assert.include(
							Cause.pretty(failed.cause),
							expect === undefined ? "instance id" : "mismatch",
						)
					yield* proxy.dispose
				}
				const applied = yield* fs.exists(directory + "/pid")
				assert.isFalse(applied)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		90_000,
	)
})
