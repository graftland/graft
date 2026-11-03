import { assert, describe, it } from "@effect/vitest"
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Scope,
	String,
} from "effect"
import { Graft, Event, Plugin } from "../src/index.ts"
import { makeJournal, reach, run } from "./utils.ts"

const Message = Event.make<[text: string]>("message")
const Failing = Event.make<[], void, string>("failing")
const Command = Event.make<[name: string], Option.Option<string>>("command")
const Render = Event.middleware<string, string>("render")

const Channel = Context.Reference<string>(
	"@graftland/graft/test/event.test/Channel",
	{ defaultValue: () => "general" },
)

class Prefix extends Context.Service<Prefix, string>()(
	"@graftland/graft/test/event.test/Prefix",
) {}

describe("events", () => {
	it.effect("calls handlers in order, honouring prepend", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			yield* Event.on(Message, (text) => journal.record(`first ${text}`))
			yield* Event.on(Message, (text) => journal.record(`second ${text}`))
			yield* Event.on(Message, (text) => journal.record(`zeroth ${text}`), {
				prepend: true,
			})
			yield* Event.emit(Message, "hi")
			yield* journal.expect(["zeroth hi", "first hi", "second hi"])
		}).pipe(run),
	)

	it.effect("removes handlers when their scope closes", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const scope = yield* Scope.make()
			yield* Event.on(Message, (text) => journal.record(text)).pipe(
				Scope.provide(scope),
			)
			yield* Event.emit(Message, "before")
			yield* Scope.close(scope, Exit.void)
			yield* Event.emit(Message, "after")
			yield* journal.expect(["before"])
		}).pipe(run),
	)

	it.effect(
		"runs a once handler a single time, even when it dispatches again",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				yield* Event.once(Message, (text) =>
					Effect.andThen(
						journal.record(`once ${text}`),
						Event.emit(Message, "again"),
					),
				)
				yield* Event.emit(Message, "hi")
				yield* Event.emit(Message, "later")
				yield* journal.expect(["once hi"])
			}).pipe(run),
	)

	it.effect("skips handlers unregistered during a dispatch", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const scope = yield* Scope.make()
			yield* Event.on(Message, () => Scope.close(scope, Exit.void))
			yield* Event.on(Message, (text) => journal.record(text)).pipe(
				Scope.provide(scope),
			)
			yield* Event.emit(Message, "hi")
			yield* journal.expect([])
		}).pipe(run),
	)

	it.effect("propagates typed failures and combines them in parallel", () =>
		Effect.gen(function* () {
			yield* Event.on(Failing, () => Effect.fail("left"))
			yield* Event.on(Failing, () => Effect.fail("right"))
			const sequential = yield* Effect.flip(Event.emit(Failing))
			assert.strictEqual(sequential, "left")
			const exit = yield* Effect.exit(Event.parallel(Failing))
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.deepStrictEqual(Cause.prettyErrors(exit.cause).length, 2)
		}).pipe(run),
	)

	it.effect("bails out with the first handler that answers", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			yield* Event.on(Command, (name) =>
				Effect.as(journal.record(`skip ${name}`), Option.none()),
			)
			yield* Event.on(Command, (name) => Effect.succeedSome(`ran ${name}`))
			yield* Event.on(Command, (name) =>
				Effect.as(journal.record(`late ${name}`), Option.none()),
			)
			const result = yield* Event.bail(Command, "help")
			assert.deepStrictEqual(result, Option.some("ran help"))
			yield* journal.expect(["skip help"])
		}).pipe(run),
	)

	it.effect("threads input through middleware", () =>
		Effect.gen(function* () {
			yield* Event.on(Render, (input, next) =>
				Effect.map(next(`<b>${input}</b>`), (out) => `[${out}]`),
			)
			yield* Event.on(Render, (input, next) => next(String.toUpperCase(input)))
			const result = yield* Event.waterfall(Render, "hi", (input) =>
				Effect.succeed(input),
			)
			assert.strictEqual(result, "[<B>HI</B>]")
		}).pipe(run),
	)

	it.effect("treats calling next twice as a defect", () =>
		Effect.gen(function* () {
			yield* Event.on(Render, (input, next) =>
				Effect.andThen(next(input), next(input)),
			)
			const exit = yield* Effect.exit(
				Event.waterfall(Render, "hi", Effect.succeed),
			)
			assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
		}).pipe(run),
	)

	it.effect(
		"runs handlers with the services of the plugin that registered them",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const listener = Plugin.make({
					name: "listener",
					inject: [Prefix],
					apply: () =>
						Event.on(Message, (text) =>
							Effect.flatMap(Prefix, (prefix) =>
								journal.record(`${prefix} ${text}`),
							),
						),
				})
				yield* Effect.flatMap(
					Graft.plugin(
						Plugin.service(Prefix, Effect.succeed(">"), { name: "prefix" }),
					),
					(fork) => fork.await,
				)
				yield* Effect.flatMap(Graft.plugin(listener), (fork) => fork.await)
				yield* Event.emit(Message, "hi")
				yield* journal.expect(["> hi"])
			}).pipe(run),
	)

	it.effect("keeps isolated realms apart unless a handler is global", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const room = (name: string) =>
				Plugin.make({
					name,
					apply: () =>
						Effect.gen(function* () {
							yield* Event.on(Message, (text) =>
								journal.record(`${name} heard ${text}`),
							)
							yield* Event.emit(Message, `from ${name}`)
						}),
				})
			yield* Event.on(Message, (text) => journal.record(`root heard ${text}`))
			yield* Event.on(
				Message,
				(text) => journal.record(`monitor heard ${text}`),
				{ global: true },
			)
			yield* Effect.flatMap(
				Graft.plugin(room("left"), undefined, { isolate: [Message] }),
				(fork) => fork.await,
			)
			yield* journal.expect(["monitor heard from left", "left heard from left"])
		}).pipe(run),
	)

	it.effect("filters handlers by the context they were registered in", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const listener = (channel: string) =>
				Event.on(Message, (text) => journal.record(`${channel}: ${text}`)).pipe(
					Effect.provideService(Channel, channel),
				)
			yield* listener("general")
			yield* listener("random")
			yield* Event.emit(Message, "hi").pipe(
				Event.filtered((owner) => Context.get(owner, Channel) === "random"),
			)
			yield* journal.expect(["random: hi"])
		}).pipe(run),
	)

	it.effect("interrupts a running handler when its owner unloads", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const started = yield* Deferred.make<void>()
			const listener = Plugin.make({
				name: "slow listener",
				apply: () =>
					Event.on(Message, () =>
						Effect.andThen(
							Deferred.succeed(started, undefined),
							Effect.onInterrupt(Effect.never, () =>
								journal.record("interrupted"),
							),
						),
					),
			})
			const fork = yield* Graft.plugin(listener)
			yield* fork.await
			const dispatch = yield* Effect.forkChild(Event.emit(Message, "hi"))
			yield* Deferred.await(started)
			yield* fork.dispose
			yield* reach(fork, "Disposed")
			const exit = yield* Fiber.await(dispatch)
			assert.isTrue(Exit.isSuccess(exit))
			yield* journal.expect(["interrupted"])
		}).pipe(run),
	)
})
