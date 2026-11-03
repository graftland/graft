import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { Event } from "../src/index.ts"
import { makeJournal, run } from "./utils.ts"

describe("waterfall sharing", () => {
	it.effect(
		"preserves downstream cleanup defects when the entire dispatch is cancelled",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string>("cancelled-dispatch")
				const entered = yield* Deferred.make<void>()
				yield* Event.on(event, (input, next) => next(input))
				const dispatch = yield* Effect.forkScoped(
					Event.waterfall(event, "input", () =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(Effect.die("downstream cleanup defect")),
						),
					),
				)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(dispatch)
				const exit = yield* Fiber.await(dispatch)
				assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
				if (Exit.isFailure(exit))
					assert.include(Cause.pretty(exit.cause), "downstream cleanup defect")
			}).pipe(run),
	)

	it.effect("shares one execution between concurrent next callers", () =>
		Effect.gen(function* () {
			const event = Event.middleware<string, string>("concurrent-next")
			const journal = yield* makeJournal
			const entered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			yield* Event.on(event, (input, next) =>
				Effect.gen(function* () {
					const first = yield* Effect.forkChild(next(input))
					yield* Deferred.await(entered)
					const second = yield* Effect.forkChild(next("ignored"))
					yield* Deferred.succeed(release, undefined)
					const left = yield* Fiber.join(first)
					const right = yield* Fiber.join(second)
					assert.strictEqual(left, right)
					return left
				}),
			)
			const result = yield* Event.waterfall(event, "first", (input) =>
				journal
					.record(input)
					.pipe(
						Effect.andThen(Deferred.succeed(entered, undefined)),
						Effect.andThen(Deferred.await(release)),
						Effect.as(input),
					),
			)
			assert.strictEqual(result, "first")
			yield* journal.expect(["first"])
		}).pipe(run),
	)

	it.effect(
		"shares a failed downstream result after the caller's owner closes",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string, string>("failed-next")
				const journal = yield* makeJournal
				const owner = yield* Scope.make()
				const observed = yield* Deferred.make<void>()
				yield* Event.on(event, (input, next) =>
					Effect.exit(next(input)).pipe(
						Effect.andThen(Deferred.succeed(observed, undefined)),
						Effect.andThen(Effect.never),
					),
				).pipe(Scope.provide(owner))
				const dispatch = yield* Effect.forkScoped(
					Event.waterfall(event, "input", () =>
						journal
							.record("failed once")
							.pipe(Effect.andThen(Effect.fail("downstream failure"))),
					),
				)
				yield* Deferred.await(observed)
				yield* Scope.close(owner, Exit.void)
				const result = yield* Fiber.await(dispatch)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result))
					assert.include(Cause.pretty(result.cause), "downstream failure")
				yield* journal.expect(["failed once"])
			}).pipe(run),
	)

	it.effect(
		"preserves cancellation when the owner closes during downstream execution",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string>("cancelled-next")
				const journal = yield* makeJournal
				const owner = yield* Scope.make()
				const entered = yield* Deferred.make<void>()
				yield* Event.on(event, (input, next) => next(input)).pipe(
					Scope.provide(owner),
				)
				const dispatch = yield* Effect.forkScoped(
					Event.waterfall(event, "input", () =>
						journal
							.record("started")
							.pipe(
								Effect.andThen(Deferred.succeed(entered, undefined)),
								Effect.andThen(Effect.never),
								Effect.ensuring(journal.record("stopped")),
							),
					),
				)
				yield* Deferred.await(entered)
				yield* Scope.close(owner, Exit.void)
				const result = yield* Fiber.await(dispatch)
				assert.isTrue(
					Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause),
				)
				yield* journal.expect(["started", "stopped"])
			}).pipe(run),
	)

	it.effect("continues past an unregistered handler using the same next", () =>
		Effect.gen(function* () {
			const event = Event.middleware<string, string>("skipped-next")
			const owner = yield* Scope.make()
			const journal = yield* makeJournal
			yield* Event.on(event, (input, next) =>
				Scope.close(owner, Exit.void).pipe(Effect.andThen(next(input))),
			)
			yield* Event.on(event, () => Effect.die("Unregistered handler ran")).pipe(
				Scope.provide(owner),
			)
			const result = yield* Event.waterfall(event, "input", (input) =>
				journal.record(input).pipe(Effect.as(input)),
			)
			assert.strictEqual(result, "input")
			yield* journal.expect(["input"])
		}).pipe(run),
	)
})
