import { createServer, type Socket } from "node:net"

import {
	Array,
	Deferred,
	Effect,
	Fiber,
	FiberSet,
	FileSystem,
	HashMap,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
	String,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import * as Journal from "../../plugin-release/dist/Journal.js"

const executable = new URL("../.cache/commands/cli/bin.js", import.meta.url)
	.pathname
const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
const Reply = Schema.Struct({
	id: Schema.String,
	version: Schema.Int,
	term: Schema.Int,
	session: Schema.Int,
})
class GatewayIOError extends Schema.TaggedError<
	GatewayIOError,
	{ readonly brand: unique symbol }
>()("GatewayIOError", { cause: Schema.Unknown }) {}
const decode = Schema.decodeEffect(Schema.fromJsonString(Reply))

/** The upstream session belongs to the gateway; every business request uses that same socket. */
const upstream = Effect.fnUntraced(function* () {
	const tasks = yield* FiberSet.make<
		void,
		GatewayIOError | Schema.SchemaError
	>()
	const run = yield* FiberSet.runtime(tasks)()
	const connection = yield* Deferred.make<Socket>()
	const ready = yield* Deferred.make<number>()
	const sessions = yield* Ref.make(0)
	const next = yield* Ref.make(0)
	const pending = yield* Ref.make(
		HashMap.empty<string, Deferred.Deferred<typeof Reply.Type>>(),
	)
	const server = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createServer((socket) =>
				run(
					Effect.scoped(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => socket.destroy()),
							)
							yield* Ref.update(sessions, (n) => n + 1)
							yield* Deferred.succeed(connection, socket)
							yield* Stream.fromAsyncIterable<Uint8Array, GatewayIOError>(
								socket,
								(cause) => GatewayIOError.make({ cause }),
							).pipe(
								Stream.decodeText(),
								Stream.splitLines,
								Stream.runForEach((line) =>
									decode(line).pipe(
										Effect.flatMap((reply) =>
											reply.id === "ready"
												? Deferred.succeed(ready, reply.session)
												: Ref.get(pending).pipe(
														Effect.flatMap((waiters) =>
															Option.match(HashMap.get(waiters, reply.id), {
																onNone: () =>
																	Effect.die(
																		"The gateway replied without a pending request",
																	),
																onSome: (waiter) =>
																	Deferred.succeed(waiter, reply),
															}),
														),
													),
										),
									),
								),
							)
						}),
					),
				),
			),
		),
		(server) =>
			Effect.sync(() => {
				server.close()
			}),
	)
	const port = yield* Effect.callback<number, GatewayIOError>((resume) => {
		server.once("error", (cause) => resume(GatewayIOError.make({ cause })))
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			const address = server.address()
			resume(
				address !== null && typeof address !== "string"
					? Effect.succeed(address.port)
					: Effect.die("No upstream listener address"),
			)
		})
	})
	const call = Effect.fnUntraced(function* () {
		const socket = yield* Deferred.await(connection)
		const sequence = yield* Ref.getAndUpdate(next, (n) => n + 1)
		const id = globalThis.String(sequence)
		const waiter = yield* Deferred.make<typeof Reply.Type>()
		yield* Ref.update(pending, HashMap.set(id, waiter))
		const frame = yield* encode({ id, city: "Taipei" })
		return yield* Effect.callback<void, GatewayIOError>((resume) => {
			socket.write(frame + "\n", (error) =>
				resume(
					error !== undefined && error !== null
						? GatewayIOError.make({ cause: error })
						: Effect.void,
				),
			)
		}).pipe(
			Effect.andThen(Deferred.await(waiter)),
			Effect.ensuring(Ref.update(pending, HashMap.remove(id))),
			Effect.raceFirst(
				FiberSet.join(tasks).pipe(
					Effect.andThen(Effect.die("The gateway upstream stopped")),
				),
			),
			Effect.timeout("15 seconds"),
		)
	})
	return {
		port,
		call,
		session: Deferred.await(ready),
		sessions: Ref.get(sessions),
	}
})

it.live(
	"records a real CLI watch upgrade while the gateway keeps its generation and upstream session (P17)",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const root = new URL("../.cache/recorded-gateway-tests/", import.meta.url)
				.pathname
			yield* fs.makeDirectory(root, { recursive: true })
			const directory = yield* fs.makeTempDirectoryScoped({ directory: root })
			const u = yield* upstream()
			yield* fs.writeFileString(
				`${directory}/package.json`,
				'{"name":"recorded-gateway","type":"module"}',
			)
			const recorder = `${directory}/node_modules/@graftland/plugin-release`
			yield* fs.makeDirectory(recorder, { recursive: true })
			yield* fs.copy(
				new URL("../../plugin-release/dist/", import.meta.url).pathname,
				`${recorder}/dist`,
			)
			yield* fs.writeFileString(
				`${recorder}/package.json`,
				'{"name":"@graftland/plugin-release","type":"module","exports":{"./Recorder":"./dist/Recorder.js"}}',
			)
			const sample = new URL(
				"../../../samples/integration-gateway/src/units/",
				import.meta.url,
			).pathname
			for (const name of ["contracts", "integration", "gateway"]) {
				yield* fs.makeDirectory(`${directory}/${name}`)
				yield* fs.writeFileString(
					`${directory}/${name}/package.json`,
					`{"name":"${name}","type":"module"}`,
				)
			}
			for (const name of [
				"shared.mjs",
				"provider-contract.mjs",
				"consumer-contract.mjs",
			])
				yield* fs.copy(`${sample}/${name}`, `${directory}/contracts/${name}`)
			const shared = yield* quote(
				new URL(`file://${directory}/contracts/shared.mjs`).href,
			)
			for (const [name, file] of [
				["integration", "provider.mjs"],
				["gateway", "gateway.mjs"],
			] as const) {
				const text = yield* fs.readFileString(`${sample}/${file}`)
				yield* fs.writeFileString(
					`${directory}/${name}/${file}`,
					String.replaceAll('"./shared.mjs"', shared)(text),
				)
				yield* fs.copy(
					`${sample}/socket.mjs`,
					`${directory}/${name}/socket.mjs`,
				)
			}
			const version = (value: number) =>
				fs.writeFileString(
					`${directory}/integration/index.mjs`,
					`import {make} from "./provider.mjs";export default make(${value});`,
				)
			yield* version(1)
			const config = (
				role: string = "release",
				declared: boolean = true,
			) => `- id: release
  name: "@graftland/plugin-release/Recorder"
${declared ? `  recording: { role: ${role} }\n` : ""}  config:
    recorder: release
    directory: ${directory}/.graft/journal
- id: integration
  name: ./integration/index.mjs
  contract: { artifact: ./contracts/provider-contract.mjs, module: provider-contract.mjs }
  config: { upstream: ${u.port}, gate: 0 }
- id: gateway
  name: ./gateway/gateway.mjs
  contract: { artifact: ./contracts/provider-contract.mjs, module: consumer-contract.mjs }
  config: { upstream: ${u.port}, gate: 0 }
`
			yield* fs.writeFileString(`${directory}/graft.yml`, config())
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[
						executable,
						"--no-plugins",
						"start",
						`${directory}/graft.yml`,
						"--watch",
					],
					{
						cwd: directory,
						env: { GRAFT_HOME: `${directory}/.graft/home` },
						extendEnv: true,
					},
				),
			)
			const lines = yield* Ref.make<ReadonlyArray<string>>([])
			const output = yield* child.all.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.runForEach((line) => Ref.update(lines, Array.append(line))),
				Effect.forkScoped,
			)
			const seen = (text: string, from: number = 0) =>
				Ref.get(lines).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("20 millis"),
						until: (lines) =>
							Array.some(Array.drop(lines, from), String.includes(text)),
					}),
					Effect.timeout("25 seconds"),
					Effect.tapCause((cause) =>
						Ref.get(lines).pipe(
							Effect.flatMap((lines) =>
								Effect.logError(
									"CLI did not reach " + text,
									Array.join(lines, "\n"),
									cause,
								),
							),
						),
					),
					Effect.raceFirst(
						Fiber.join(output).pipe(
							Effect.andThen(Ref.get(lines)),
							Effect.flatMap((lines) => Effect.die(Array.join(lines, "\n"))),
						),
					),
				)
			yield* seen("Running ")
			const session = yield* u.session.pipe(Effect.timeout("15 seconds"))
			const before = yield* u.call()
			assert.equal(before.version, 1)
			assert.equal(before.session, session)
			const initial = yield* Journal.history(`${directory}/.graft/journal`)
			assert.lengthOf(initial, 1)
			assert.deepStrictEqual(initial[0]?.stages, [
				"Intent",
				"Commit",
				"Conclusion",
			])
			yield* version(2)
			const history = yield* Journal.history(
				`${directory}/.graft/journal`,
			).pipe(
				Effect.repeat({
					schedule: Schedule.spaced("25 millis"),
					until: (history) =>
						history.length === 2 &&
						Array.every(history, (change) => change.concluded),
				}),
				Effect.timeout("25 seconds"),
			)
			const upgraded = history[1]
			assert.isDefined(upgraded)
			assert.deepStrictEqual(upgraded?.members, ["integration"])
			assert.deepStrictEqual(upgraded?.stages, [
				"Intent",
				"Commit",
				"Conclusion",
			])
			assert.isTrue(Option.contains(upgraded!.outcome, "Accepted"))
			assert.deepStrictEqual(
				Array.map(upgraded!.facts, (fact) => ({
					instance: fact.instance,
					healthy: fact.healthy,
					matches: fact.actual === fact.desired,
				})),
				[{ instance: "integration", healthy: true, matches: true }],
			)
			const after = yield* u.call()
			const connections = yield* u.sessions
			assert.equal(after.version, 2)
			assert.isAbove(after.term, before.term)
			assert.equal(after.session, session)
			assert.equal(connections, 1)
			// Declaration edits fail before admitting work; the same serving session remains usable.
			yield* fs.writeFileString(`${directory}/graft.yml`, config("other"))
			yield* seen("RecordingConflict")
			const afterRoleError = yield* Ref.get(lines)
			yield* fs.writeFileString(
				`${directory}/graft.yml`,
				config("release", false),
			)
			yield* seen("RecordingConflict", afterRoleError.length)
			const unchanged = yield* Journal.history(`${directory}/.graft/journal`)
			assert.lengthOf(unchanged, 2)
			const still = yield* u.call()
			assert.equal(still.version, 2)
			assert.equal(still.session, session)
			yield* child.kill()
			yield* Fiber.join(output)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	90000,
)
