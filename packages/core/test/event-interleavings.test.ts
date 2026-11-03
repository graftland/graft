import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Ref, Scope } from "effect"
import { Event } from "../src/index.ts"
import { makeJournal, run } from "./utils.ts"

describe("event interleavings", () => {
	it.effect(
		"claims a once handler only once across concurrent parallel dispatches",
		() =>
			Effect.gen(function* () {
				const event = Event.make<[], string>("parallel-once")
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const calls = yield* Ref.make(0)
				yield* Event.once(event, () =>
					Ref.update(calls, (n) => n + 1).pipe(
						Effect.andThen(Deferred.succeed(entered, undefined)),
						Effect.andThen(Deferred.await(release)),
						Effect.as("answer"),
					),
				)
				const first = yield* Effect.forkScoped(Event.parallel(event))
				yield* Deferred.await(entered)
				const concurrent = yield* Event.parallel(event)
				assert.deepStrictEqual(concurrent, [])
				yield* Deferred.succeed(release, undefined)
				const result = yield* Fiber.join(first)
				const count = yield* Ref.get(calls)
				assert.deepStrictEqual(result, ["answer"])
				assert.strictEqual(count, 1)
			}).pipe(run),
	)

	it.effect("does not consume a once handler skipped by bail", () =>
		Effect.gen(function* () {
			const event = Event.make<[], Option.Option<string>>("bail-once")
			const firstOwner = yield* Scope.make()
			yield* Event.on(event, () => Effect.succeedSome("first")).pipe(
				Scope.provide(firstOwner),
			)
			yield* Event.once(event, () => Effect.succeedSome("once"))
			const first = yield* Event.bail(event)
			assert.deepStrictEqual(first, Option.some("first"))
			yield* Scope.close(firstOwner, Exit.void)
			const second = yield* Event.bail(event)
			const third = yield* Event.bail(event)
			assert.deepStrictEqual(second, Option.some("once"))
			assert.deepStrictEqual(third, Option.none())
		}).pipe(run),
	)

	it.effect(
		"does not replay downstream middleware after its caller's owner closes",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string>("waterfall-owner")
				const journal = yield* makeJournal
				const owner = yield* Scope.make()
				const returned = yield* Deferred.make<void>()
				yield* Event.on(event, (input, next) =>
					next(input).pipe(
						Effect.andThen(Deferred.succeed(returned, undefined)),
						Effect.andThen(Effect.never),
					),
				).pipe(Scope.provide(owner))
				yield* Event.on(event, (input, next) =>
					journal.record("downstream").pipe(Effect.andThen(next(input))),
				)
				const dispatch = yield* Effect.forkScoped(
					Event.waterfall(event, "input", (input) =>
						journal.record("last").pipe(Effect.as(input)),
					),
				)
				yield* Deferred.await(returned)
				yield* Scope.close(owner, Exit.void)
				yield* Fiber.await(dispatch)
				yield* journal.expect(["downstream", "last"])
			}).pipe(run),
	)
})
