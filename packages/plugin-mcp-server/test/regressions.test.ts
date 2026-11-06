import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	Queue,
	Ref,
	Schema,
	Sink,
	Stdio,
	Stream,
	String,
	type Scope,
} from "effect"
import { McpTest, Tool, Toolkit } from "effect/ai"
import { assert, describe, it } from "@effect/vitest"

import { Application, ProtocolOutput } from "@graftland/cli/Application"
import { Event, Graft, Plugin } from "@graftland/graft"

import { Offered as Tools, Changed as ToolsChanged } from "../src/Catalog.ts"
import core from "../src/index.ts"
import host from "../src/stdio.ts"
import { kind, plugin as tools, type Registration } from "../src/Tools.ts"
import * as Testing from "./support.ts"

const Clock = Toolkit.make(
	Tool.make("now", {
		description: "The current time",
		success: Schema.String,
	}),
)

const clock = (time: string) =>
	tools({
		name: `clock ${time}`,
		toolkit: Clock,
		handlers: Effect.succeed(Clock.of({ now: () => Effect.succeed(time) })),
	})

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

const connect = Effect.gen(function* () {
	const coreFork = yield* Graft.plugin(core, {})
	yield* coreFork.await
	const transport = yield* Testing.transport({ protocolVersion: "2025-11-25" })
	yield* (yield* Graft.plugin(transport.plugin)).await
	return yield* transport.client
})

const listed = (client: McpTest.Client) =>
	Effect.map(client.listTools(), (result) =>
		Array.map(result.tools, (tool) => tool.name),
	)

const time = (client: McpTest.Client) =>
	Effect.map(client.callTool({ name: "now", arguments: {} }), (result) =>
		Array.join(
			Array.map(result.content, (content) =>
				content.type === "text" ? content.text : content.type,
			),
			"",
		),
	)

/** Notifications the client has received so far, by method. */
const notified = (client: McpTest.Client) =>
	Effect.map(Queue.clear(client.notifications), (all) =>
		Array.map(all, (notification) => notification.method),
	)

const expectListed = (
	client: McpTest.Client,
	expected: ReadonlyArray<string>,
) =>
	Effect.map(listed(client), (names) => assert.deepStrictEqual(names, expected))

const expectTime = (client: McpTest.Client, expected: string) =>
	Effect.map(time(client), (actual) => assert.strictEqual(actual, expected))

const expectListChanged = (client: McpTest.Client) =>
	Effect.map(notified(client), (methods) =>
		assert.isTrue(Array.contains(methods, "notifications/tools/list_changed")),
	)

describe("review regressions", () => {
	it.effect(
		"announces a previously installed tool becoming visible after conflict resolution",
		() =>
			Effect.gen(function* () {
				const first = yield* Graft.plugin(clock("12:00"))
				yield* first.await
				const client = yield* connect
				yield* expectTime(client, "12:00")
				const second = yield* Graft.plugin(clock("13:00"))
				yield* second.await
				yield* expectListed(client, [])
				yield* notified(client)
				yield* second.dispose
				yield* expectListed(client, ["now"])
				yield* expectTime(client, "12:00")
				yield* expectListChanged(client)
			}).pipe(run),
	)
})

it.effect("interrupts the owned handler when its caller is cancelled", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const stopped = yield* Deferred.make<void>()
		const slow = tools({
			name: "cancelled call",
			toolkit: Clock,
			handlers: Effect.succeed(
				Clock.of({
					now: () =>
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(Deferred.succeed(stopped, undefined)),
						),
				}),
			),
		})
		const fork = yield* Graft.plugin(slow)
		yield* fork.await
		const answers = yield* Event.parallel(Tools)
		const registration = Array.flatten(answers)[0]!.item as Registration
		const built = yield* Clock.pipe(
			Effect.provide(
				registration.handlers as Context.Context<
					Tool.HandlersFor<typeof Clock.tools>
				>,
			),
		)
		const call = yield* built
			.handle("now", {})
			.pipe(Effect.flatMap(Stream.runDrain), Effect.forkChild)
		yield* Deferred.await(started)
		yield* Fiber.interrupt(call)
		const didStop = yield* Deferred.isDone(stopped)
		assert.isTrue(didStop)
	}).pipe(run),
)

it.effect(
	"restores the offered handler after a partially failed synchronization",
	() =>
		Effect.gen(function* () {
			const makeRegistration = (value: string) =>
				Effect.map(
					Clock.toHandlers(Clock.of({ now: () => Effect.succeed(value) })),
					(handlers): Registration => ({
						toolkit: Clock as unknown as Registration["toolkit"],
						handlers: handlers as Registration["handlers"],
					}),
				)
			const original = yield* makeRegistration("original")
			const replacement = yield* makeRegistration("replacement")
			const Broken = Toolkit.make(
				Tool.make("broken", {
					parameters: Schema.String,
					success: Schema.String,
				}),
			)
			const badHandlers = yield* Broken.toHandlers(
				Broken.of({ broken: () => Effect.succeed("broken") }),
			)
			const broken: Registration = {
				toolkit: Broken as unknown as Registration["toolkit"],
				handlers: badHandlers as Registration["handlers"],
			}
			const offered = yield* Ref.make<ReadonlyArray<Registration>>([original])
			const source = Plugin.make({
				name: "dynamic registry",
				apply: () =>
					Event.on(Tools, () =>
						Ref.get(offered).pipe(
							Effect.map((items) =>
								Array.map(items, (item) => ({ kind, item })),
							),
						),
					),
			})
			yield* (yield* Graft.plugin(source)).await
			const client = yield* connect
			yield* expectTime(client, "original")
			yield* Ref.set(offered, [replacement, broken])
			// A toolkit that fails to register is logged and hidden; the emitter is not failed.
			const emitted = yield* Effect.exit(Event.emit(ToolsChanged))
			assert.isTrue(Exit.isSuccess(emitted))
			const visible = yield* Effect.map(client.listTools(), (result) =>
				Array.map(result.tools, (tool) => tool.name),
			)
			assert.deepStrictEqual(visible, ["now"])
			yield* Ref.set(offered, [original])
			yield* Event.emit(ToolsChanged)
			yield* expectTime(client, "original")
		}).pipe(run),
)

for (const stdio of [false, true]) {
	it.effect(`observes the CLI Application provision with stdio: ${stdio}`, () =>
		Effect.gen(function* () {
			const claims = yield* Ref.make(0)
			yield* Graft.provide(Application, {
				claimProtocol: Ref.update(claims, (count) => count + 1),
				finish: () => Effect.void,
				onExit: () => Effect.void,
			})
			yield* (yield* Graft.plugin(core, {})).await
			const fork = yield* Graft.plugin(host, {})
			const activation = yield* Effect.exit(fork.await)
			if (stdio) {
				assert.isTrue(Exit.isSuccess(activation))
				const count = yield* Ref.get(claims)
				assert.strictEqual(count, 1)
			} else {
				assert.isTrue(Exit.isFailure(activation))
			}
		}).pipe(
			Effect.scoped,
			Effect.provideService(ProtocolOutput, stdio),
			Effect.provide(
				Layer.provideMerge(
					Graft.layer,
					Stdio.layerTest({ stdin: Stream.never }),
				),
			),
		),
	)
}

it.effect("finishes the application once the client closes stdin", () =>
	Effect.gen(function* () {
		const writing = yield* Deferred.make<void>()
		const release = yield* Deferred.make<void>()
		const written = yield* Ref.make<ReadonlyArray<string>>([])
		const finished = yield* Deferred.make<ReadonlyArray<string>>()
		const stdio = Stdio.layerTest({
			stdin: Stream.make(
				new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'),
			),
			stdout: () =>
				Sink.forEach((chunk: string | Uint8Array) =>
					Deferred.succeed(writing, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.andThen(
							Ref.update(written, (all) => [
								...all,
								typeof chunk === "string"
									? chunk
									: new TextDecoder().decode(chunk),
							]),
						),
					),
				),
		})
		yield* Effect.gen(function* () {
			yield* Graft.provide(Application, {
				claimProtocol: Effect.void,
				finish: (exit) =>
					Exit.isSuccess(exit)
						? Effect.andThen(Ref.get(written), (all) =>
								Deferred.succeed(finished, all),
							)
						: Effect.void,
				onExit: () => Effect.void,
			})
			yield* (yield* Graft.plugin(core, {})).await
			const fork = yield* Graft.plugin(host, {})
			yield* fork.await
			yield* Deferred.await(writing)
			const didFinish = yield* Deferred.isDone(finished)
			assert.isFalse(didFinish)
			yield* Deferred.succeed(release, undefined)
			// The reply to the last request is written before the application finishes.
			const output = yield* Deferred.await(finished)
			assert.isTrue(String.includes('"id":1')(Array.join(output, "")))
		}).pipe(
			Effect.scoped,
			Effect.provideService(ProtocolOutput, true),
			Effect.provide(Layer.provideMerge(Graft.layer, stdio)),
		)
	}),
)

it.effect(
	"does not finish the application on restart, replacement or unload",
	() =>
		Effect.gen(function* () {
			const finishes = yield* Ref.make(0)
			yield* Graft.provide(Application, {
				claimProtocol: Effect.void,
				finish: () => Ref.update(finishes, (count) => count + 1),
				onExit: () => Effect.void,
			})
			yield* (yield* Graft.plugin(core, {})).await
			const fork = yield* Graft.plugin(host, {})
			yield* fork.await
			yield* fork.restart
			yield* fork.await
			const replacement = { ...host, name: "replacement host" }
			const result = yield* Graft.replace([[host, replacement]])
			assert.strictEqual(result._tag, "Replaced")
			yield* fork.dispose
			const count = yield* Ref.get(finishes)
			assert.strictEqual(count, 0)
		}).pipe(
			Effect.scoped,
			Effect.provideService(ProtocolOutput, true),
			Effect.provide(
				Layer.provideMerge(
					Graft.layer,
					Stdio.layerTest({ stdin: Stream.never }),
				),
			),
		),
)

it.effect(
	"reports a handler cleanup defect after its caller has been cancelled",
	() =>
		Effect.gen(function* () {
			const logged = yield* Queue.unbounded<Logger.Options<unknown>>()
			const logger = Logger.layer([
				Logger.make((entry) => {
					Queue.offerUnsafe(logged, entry)
				}),
			])
			const result = yield* Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const slow = tools({
					name: "cancelled failing cleanup",
					toolkit: Clock,
					handlers: Effect.succeed(
						Clock.of({
							now: () =>
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(Effect.die("tool cleanup defect")),
								),
						}),
					),
				})
				const fork = yield* Graft.plugin(slow)
				yield* fork.await
				const answers = yield* Event.parallel(Tools)
				const registration = Array.flatten(answers)[0]!.item as Registration
				const built = yield* Clock.pipe(
					Effect.provide(
						registration.handlers as Context.Context<
							Tool.HandlersFor<typeof Clock.tools>
						>,
					),
				)
				const call = yield* built
					.handle("now", {})
					.pipe(Effect.flatMap(Stream.runDrain), Effect.forkChild)
				yield* Deferred.await(started)
				yield* Fiber.interrupt(call)
				const cancelled = yield* Fiber.await(call)
				const disposed = yield* Effect.exit(fork.dispose)
				return [cancelled, disposed] as const
			}).pipe(run, Effect.provide(logger))
			const exits = Array.flatMap(result, (exit) =>
				exit._tag === "Failure" ? [Cause.pretty<unknown>(exit.cause)] : [],
			)
			const logs = yield* Queue.clear(logged)
			const loggedCauses = Array.flatMap(logs, (entry) => [
				Cause.pretty(entry.cause),
				...(Array.isArray(entry.message)
					? Array.flatMap(entry.message, (message) =>
							Cause.isCause(message) ? [Cause.pretty(message)] : [],
						)
					: []),
			])
			assert.isTrue(
				Array.some([...exits, ...loggedCauses], (text) =>
					String.includes("tool cleanup defect")(text),
				),
			)
		}),
)
