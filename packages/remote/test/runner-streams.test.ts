import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Schema,
	String,
	Schedule,
	Sink,
	Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient } from "effect/rpc"
import { inject, expectTypeOf } from "vitest"
import process from "node:process"
import * as Remote from "../src/index"
import * as Targets from "../src/Targets"
import * as Port from "../src/internal/port"
import * as Multiplex from "../src/internal/runner/Multiplex"
import * as Framing from "../src/internal/runner/Framing"
import * as Wire from "../src/internal/runner/Wire"
import { childOf, defaults } from "../src/internal/runner/model"
import { command } from "../src/internal/runner/command"
import * as Lock from "../src/internal/runner/Lock"
import { TransportError } from "../src/Errors"
import unix from "../src/host/unix"
import launcher from "../src/host/command"
import none from "../src/host/auth/none"
import { ChildApi, HostApi, contract } from "./fixtures/services-contract"

const platform = Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto)
const runtime = Graft.layer.pipe(Layer.provideMerge(platform))
const spawn = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const argv = yield* command()
	const child = yield* spawner.spawn(
		ChildProcess.make(argv[0], [...Array.drop(argv, 1), ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			forceKillAfter: "1 second",
		}),
	)
	const stderr = yield* child.stderr.pipe(
		Stream.decodeText(),
		Stream.mkString,
		Effect.forkScoped,
	)
	return { child, stderr }
})
const args = (state: string) => [
	"serve",
	"--stdio",
	"--state",
	state,
	"--root",
	inject("remoteRoot"),
]
const gone = (pid: number) =>
	Effect.sync(() => {
		try {
			process.kill(pid, 0)
			return false
		} catch {
			return true
		}
	}).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("20 millis"),
			until: (gone) => gone,
		}),
		Effect.timeout("10 seconds"),
	)

const session = Effect.fnUntraced(function* (state: string) {
	const { child, stderr } = yield* spawn(args(state))
	const decoder = Framing.decoder()
	const channel = {
		input: child.stdout.pipe(
			Stream.tap((bytes) => Effect.fromResult(decoder.decode(bytes))),
			Stream.ensuring(decoder.finish.pipe(Effect.orDie)),
			Stream.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
		output: child.stdin.pipe(
			Sink.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
	}
	const mux = yield* Multiplex.make(channel)
	const peer = yield* Port.make(Wire.channel(mux, 0), {
		session: "session-v1",
		serve: {},
		call: { session: Wire.Session },
	})
	const client = yield* RpcClient.make(Wire.Session).pipe(
		Effect.provideService(RpcClient.Protocol, peer.clientProtocol("session")),
	)
	const generation = yield* client.HighWater({ instance: "worker" })
	const record = yield* client.Open({
		instance: "worker",
		expectedGeneration: generation,
		requestId: `stream-test-${generation ?? 0}`,
		limits: defaults,
	})
	yield* client.Load({ handle: record.handle, specifier: "remote-fixture" })
	const loaded = yield* client.Status(record.handle)
	const unit = yield* Effect.fromOption(childOf(loaded))
	return { child, stderr, record, unit }
})

const proxy = Effect.fnUntraced(function* (
	target: Targets.Runner,
	directory: string,
) {
	for (const capability of [unix, launcher, none]) {
		const fork = yield* Graft.plugin(capability)
		yield* fork.await
	}
	yield* Graft.provide(HostApi, { double: (n) => Effect.succeed(n * 2) })
	const remote = yield* Graft.plugin(
		Remote.plugin(contract, { contractModule: "remote-fixture", target }),
		{ directory, fail: false },
	)
	yield* remote.await
	const found = yield* Deferred.make<typeof ChildApi.Service>()
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "stream-consumer",
			inject: [ChildApi],
			apply: () =>
				Effect.flatMap(ChildApi, (api) =>
					Deferred.succeed(found, api).pipe(Effect.asVoid),
				),
		}),
	)
	yield* consumer.await
	const api = yield* Deferred.await(found)
	const result = yield* api.call(20)
	assert.equal(result.value, 41)
	assert.equal(result.id, "worker")
	yield* remote.dispose
	yield* gone(result.pid)
	return result
})

describe("runner stream transports", () => {
	it.live(
		"runs a complete unix socket session and removes the socket on shutdown",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped({
					directory: "/tmp",
					prefix: "graft-",
				})
				const path = directory + "/runner.sock"
				yield* Effect.scoped(
					Effect.gen(function* () {
						const { child } = yield* spawn([
							"serve",
							"--listen",
							path,
							"--auth",
							"none",
							"--state",
							directory + "/state",
							"--root",
							inject("remoteRoot"),
						])
						const line = yield* child.stdout.pipe(
							Stream.decodeText(),
							Stream.splitLines,
							Stream.filter(String.includes('"Listening"')),
							Stream.runHead,
						)
						assert.isTrue(Option.isSome(line))
						yield* proxy(
							Remote.runner({
								instance: "worker",
								transport: Remote.unix({ path }),
							}),
							directory,
						)
						yield* child.kill()
						yield* child.exitCode
					}),
				)
				const exists = yield* fs.exists(path)
				assert.isFalse(exists)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		30_000,
	)

	it.live(
		"holds the stdio lock until EOF stops its child, and persists generations across invocations",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const state = directory + "/state"
				const generations = yield* Effect.forEach([1, 2], (iteration) =>
					Effect.scoped(
						Effect.gen(function* () {
							const running = yield* session(state)
							assert.equal(running.record.handle.key.identity, "anonymous")
							if (iteration === 1) {
								const second = yield* spawn(args(state))
								const stdout = yield* second.child.stdout.pipe(
									Stream.runCollect,
									Effect.forkScoped,
								)
								const code = yield* second.child.exitCode
								assert.notEqual(code, 0)
								const errors = yield* Fiber.join(second.stderr)
								assert.include(errors, "already owned or cannot be locked")
								const output = yield* Fiber.join(stdout)
								assert.lengthOf(output, 0)
							}
							yield* Stream.empty.pipe(Stream.run(running.child.stdin))
							const code = yield* running.child.exitCode
							assert.equal(code, 0)
							yield* gone(running.unit.pid)
							const stderr = yield* Fiber.join(running.stderr)
							assert.notInclude(stderr, "ERROR")
							return running.record.handle.generation
						}),
					),
				)
				assert.deepEqual(generations, [1, 2])
			}).pipe(Effect.scoped, Effect.provide(platform)),
		30_000,
	)

	it.live(
		"uses Remote.command for a complete supervised proxy session",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const argv = yield* command()
				yield* proxy(
					Remote.runner({
						instance: "worker",
						transport: Remote.command([
							argv[0],
							...Array.drop(argv, 1),
							...args(directory + "/state"),
						]),
					}),
					directory,
				)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		30_000,
	)

	it.live(
		"rejects mixed and duplicate stdio listeners during startup",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				for (const other of ["stdio", "unix"]) {
					const file = directory + "/runner.yml"
					const yaml = yield* Schema.encodeEffect(
						Schema.fromJsonString(Schema.Unknown),
					)([
						{
							name: "@graftland/remote/runner/supervisor",
							config: {
								root: inject("remoteRoot"),
								state: directory + "/state",
							},
						},
						{ name: "@graftland/remote/runner/stdio" },
						{
							name:
								other === "stdio"
									? new URL("../dist/runner/stdio.js", import.meta.url).pathname
									: "@graftland/remote/runner/unix",
							config:
								other === "unix" ? { path: directory + "/unused.sock" } : {},
						},
					])
					yield* fs.writeFileString(file, yaml)
					const { child, stderr } = yield* spawn(["serve", "--config", file])
					const stdout = yield* child.stdout.pipe(
						Stream.runCollect,
						Effect.forkScoped,
					)
					const code = yield* child.exitCode
					assert.notEqual(code, 0)
					const errors = yield* Fiber.join(stderr)
					assert.include(errors, "must be the only listener")
					const output = yield* Fiber.join(stdout)
					assert.lengthOf(output, 0)
					// Startup may acquire the lock; the failed serve must release it.
					yield* Lock.acquire(directory + "/state").pipe(Effect.scoped)
				}
			}).pipe(Effect.scoped, Effect.provide(platform)),
		30_000,
	)

	it.live(
		"rejects auth on a dynamically supplied command before connecting",
		() =>
			Effect.gen(function* () {
				expectTypeOf<
					Extract<
						Parameters<typeof Remote.runner>[0],
						{ transport: Targets.Command }
					>["auth"]
				>().toEqualTypeOf<undefined>()
				// Model a runtime object's extra field without weakening the public target type.
				const environment = {
					...Remote.command(["unused"]),
					auth: Remote.none(),
				}
				const transport: Pick<Targets.Command, "_tag" | "argv"> = environment
				const fork = yield* Graft.plugin(
					Remote.plugin(contract, {
						contractModule: "unused",
						target: Effect.succeed(Remote.runner({ transport })),
					}),
					{ directory: "unused", fail: false },
				)
				const error = yield* Effect.flip(fork.await)
				assert.include(Cause.pretty(Cause.fail(error)), "do not accept auth")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
})
