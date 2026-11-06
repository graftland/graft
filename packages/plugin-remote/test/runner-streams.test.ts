import process from "node:process"

import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Schedule,
	Schema,
	Sink,
	Stream,
	String,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient } from "effect/rpc"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { expectTypeOf, inject } from "vitest"

import { TransportError } from "../src/Errors"
import * as Remote from "../src/index"
import * as Port from "../src/internal/port"
import * as Framing from "../src/internal/runner/Framing"
import * as Lock from "../src/internal/runner/Lock"
import { childOf, defaults } from "../src/internal/runner/model"
import * as Multiplex from "../src/internal/runner/Multiplex"
import * as Wire from "../src/internal/runner/Wire"
import { cliCommand as command, runnerConfig } from "./application"
import { ChildApi, contract, HostApi } from "./fixtures/services-contract"

const platform = Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto)
const runtime = Graft.layer.pipe(Layer.provideMerge(platform))
const spawn = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const argv = yield* command
	const child = yield* spawner.spawn(
		ChildProcess.make(argv[0], [...Array.drop(argv, 1), ...args], {
			cwd: new URL("..", import.meta.url).pathname,
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
const args = (state: string) =>
	runnerConfig(state, [{ stdio: true }], { root: inject("remoteRoot") }).pipe(
		Effect.map((config) => ["start", config, "--stdio"]),
	)
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

const session = Effect.fnUntraced(function* (
	state: string,
	extra?: {
		readonly target: "local" | "worker"
		readonly mode: "normal" | "fail" | "cleanup-fail"
		readonly directory: string
	},
) {
	const argv = yield* args(state)
	if (extra !== undefined) {
		const fs = yield* FileSystem.FileSystem
		const file = yield* Effect.fromNullishOr(argv[1])
		const entries = yield* fs
			.readFileString(file)
			.pipe(
				Effect.flatMap(
					Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.Json))),
				),
			)
		const contents = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Json),
		)([
			...entries,
			{
				id: "diagnostic",
				name: "remote",
				config: {
					implementation: new URL(
						"../.cache/integration/plugin.js",
						import.meta.url,
					).href,
					contract: new URL(
						"../.cache/integration/contract.js",
						import.meta.url,
					).href,
					connect:
						extra.target === "worker"
							? { worker: { execArgv: [] } }
							: { local: {} },
					config: { directory: extra.directory, mode: extra.mode, value: 1 },
				},
			},
		])
		yield* fs.writeFileString(file, contents)
	}
	const { child, stderr } = yield* spawn(argv)
	const decoder = Framing.decoder()
	const validated = yield* Deferred.make<void, TransportError>()
	const channel = {
		input: child.stdout.pipe(
			Stream.tap((bytes) => Effect.fromResult(decoder.decode(bytes))),
			Stream.ensuring(decoder.finish.pipe(Effect.orDie)),
			Stream.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
			Stream.onExit((exit) => Deferred.done(validated, Exit.asVoid(exit))),
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
	const code = yield* client.Load({
		handle: record.handle,
		contract: "remote-fixture",
		implementation: "remote-implementation",
	})
	assert.deepEqual(code, { name: "remote-implementation", version: "2.0.0" })
	const loaded = yield* client.Status(record.handle)
	const unit = yield* Effect.fromOption(childOf(loaded))
	return { child, stderr, record, unit, validated: Deferred.await(validated) }
})

const proxy = Effect.fnUntraced(function* (
	connect: Remote.Connect,
	directory: string,
) {
	yield* Graft.provide(HostApi, { double: (n) => Effect.succeed(n * 2) })
	const remote = yield* Graft.plugin(
		Remote.plugin(contract, {
			contractModule: "remote-fixture",
			implementation: "remote-implementation",
			connect,
		}),
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
						const file = yield* runnerConfig(
							directory + "/state",
							[{ unix: path, auth: { none: {} } }],
							{ root: inject("remoteRoot") },
						)
						const { child } = yield* spawn(["start", file])
						const line = yield* child.stdout.pipe(
							Stream.decodeText(),
							Stream.splitLines,
							Stream.filter(String.includes('"Listening"')),
							Stream.runHead,
						)
						assert.isTrue(Option.isSome(line))
						yield* proxy({ instance: "worker", ...{ unix: path } }, directory)
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
				const generations = yield* Effect.forEach(
					[1, 2],
					Effect.fnUntraced(function* (iteration) {
						const running = yield* session(state)
						assert.equal(running.record.handle.key.identity, "anonymous")
						if (iteration === 1) {
							const argv = yield* args(state)
							const second = yield* spawn(argv)
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
					}, Effect.scoped),
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
				const argv = yield* command
				const invocation = yield* args(directory + "/state")
				yield* proxy(
					{
						instance: "worker",
						...{
							command: [argv[0], ...Array.drop(argv, 1), ...invocation],
							...{ cwd: new URL("..", import.meta.url).pathname },
						},
					},
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
					const file = yield* runnerConfig(
						directory + "/state",
						[
							{ stdio: true },
							other === "stdio"
								? {
										transport: {
											name: new URL("../dist/runner/stdio.js", import.meta.url)
												.pathname,
											config: {},
										},
									}
								: { unix: directory + "/unused.sock" },
						],
						{ root: inject("remoteRoot") },
					)
					const { child, stderr } = yield* spawn(["start", file, "--stdio"])
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
					// Startup may acquire the lock; the failed application must release it.
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
					Extract<Remote.Connect, { command: ReadonlyArray<string> }>["auth"]
				>().toEqualTypeOf<undefined>()
				// Model a runtime object's extra field without weakening the public target type.
				const environment = {
					...{ command: ["unused"] },
					auth: { none: {} },
				}
				const connect: { command: readonly [string, ...string[]] } = {
					command: ["unused"],
				}
				const configured = { ...connect, ...environment }
				const runtimeConnect: { command: ReadonlyArray<string> } = configured
				const fork = yield* Graft.plugin(
					Remote.plugin(contract, {
						contractModule: "unused",
						implementation: "unused",
						connect: { ...runtimeConnect, command: ["unused"] },
					}),
					{ directory: "unused", fail: false },
				)
				const error = yield* Effect.flip(fork.await)
				assert.include(Cause.pretty(Cause.fail(error)), "do not accept auth")
			}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
})

for (const target of ["local", "worker"] satisfies ReadonlyArray<
	"local" | "worker"
>) {
	for (const mode of ["normal", "fail", "cleanup-fail"] satisfies ReadonlyArray<
		"normal" | "fail" | "cleanup-fail"
	>) {
		it.live(
			`keeps ${target} diagnostics off the stdio session during ${mode}`,
			() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const directory = yield* fs.makeTempDirectoryScoped()
					yield* fs.writeFileString(directory + "/release", "ready")
					const running = yield* session(directory + "/state", {
						target,
						mode,
						directory,
					})
					yield* fs.readDirectory(directory).pipe(
						Effect.repeat({
							schedule: Schedule.spaced("20 millis"),
							until: (files) =>
								Array.some(
									files,
									String.startsWith(
										mode === "fail" ? "finalized-" : "started-",
									),
								),
						}),
						Effect.timeout("10 seconds"),
					)
					yield* Stream.empty.pipe(Stream.run(running.child.stdin))
					const code = yield* running.child.exitCode
					yield* running.validated
					assert.equal(code, mode === "cleanup-fail" ? 1 : 0)
					yield* gone(running.unit.pid)
					const stderr = yield* Fiber.join(running.stderr)
					assert.include(stderr, "Remote fixture started")
					if (target === "worker")
						assert.include(
							stderr,
							"Console output must not corrupt the control channel",
						)
					if (mode === "fail") assert.include(stderr, "Remote apply defect")
					if (mode === "cleanup-fail")
						assert.include(stderr, "Remote finalizer failed")
				}).pipe(Effect.scoped, Effect.provide(platform)),
			30_000,
		)
	}
}

it.live("rejects two runner entries sharing the process stdio channel", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped()
		const file = yield* runnerConfig(directory + "/first", [{ stdio: true }], {
			root: inject("remoteRoot"),
		})
		const entries = yield* fs
			.readFileString(file)
			.pipe(
				Effect.flatMap(
					Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.Json))),
				),
			)
		const contents = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Json),
		)([
			...entries,
			{
				id: "second",
				name: "remote/runner",
				config: {
					root: inject("remoteRoot"),
					state: directory + "/second",
					listen: [{ stdio: true }],
				},
			},
		])
		yield* fs.writeFileString(file, contents)
		const { child, stderr } = yield* spawn(["start", file, "--stdio"])
		const output = yield* child.stdout.pipe(
			Stream.runCollect,
			Effect.forkScoped,
		)
		const code = yield* child.exitCode
		assert.equal(code, 1)
		const diagnostics = yield* Fiber.join(stderr)
		assert.include(
			diagnostics,
			"Only one runner may own the process stdio channel",
		)
		yield* Fiber.join(output)
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
