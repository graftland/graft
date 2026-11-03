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
} from "effect"
import { Event } from "../src/index.ts"
import { run } from "./utils.ts"

describe("handler interruption", () => {
	for (const mode of ["emit", "parallel", "bail", "waterfall"] as const) {
		it.effect(`preserves explicit handler interruption in ${mode}`, () =>
			Effect.gen(function* () {
				const event = Event.make<[], Option.Option<string>>("self-interruption")
				const middleware = Event.middleware<string, string>(
					"self-interrupting-middleware",
				)
				yield* Event.on(event, () => Effect.interrupt)
				yield* Event.on(middleware, () => Effect.interrupt)
				const result = yield* Effect.exit(
					mode === "emit"
						? Effect.asVoid(Event.emit(event))
						: mode === "parallel"
							? Effect.asVoid(Event.parallel(event))
							: mode === "bail"
								? Effect.asVoid(Event.bail(event))
								: Effect.asVoid(
										Event.waterfall(middleware, "input", Effect.succeed),
									),
				)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result))
					assert.isTrue(Cause.hasInterruptsOnly(result.cause))
			}).pipe(run),
		)
	}
	it.effect(
		"does not inherit services from the dispatcher into a handler",
		() =>
			Effect.gen(function* () {
				class Secret extends Context.Service<Secret, string>()(
					"@graftland/graft/test/handler-interruption.test/Secret",
				) {}
				const event = Event.make<[], Option.Option<string>>("handler-context")
				yield* Event.on(event, () => Effect.serviceOption(Secret))
				const values = yield* Event.parallel(event).pipe(
					Effect.provideService(Secret, "dispatcher secret"),
				)
				assert.deepStrictEqual(values, [Option.none()])
			}).pipe(run),
	)

	it.effect(
		"preserves self interruption even when owner cleanup starts concurrently",
		() =>
			Effect.gen(function* () {
				const event = Event.make<[]>("concurrent-self-interruption")
				const owner = yield* Scope.make()
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				yield* Event.on(event, () =>
					Effect.interrupt.pipe(
						Effect.ensuring(
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
							),
						),
					),
				).pipe(Scope.provide(owner))
				const dispatch = yield* Effect.forkScoped(Event.emit(event))
				yield* Deferred.await(entered)
				const closing = yield* Effect.forkScoped(Scope.close(owner, Exit.void))
				yield* Effect.yieldNow
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(closing)
				const result = yield* Fiber.await(dispatch)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result))
					assert.isTrue(Cause.hasInterruptsOnly(result.cause))
			}).pipe(run),
	)
})
