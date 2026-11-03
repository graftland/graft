import { assert, describe, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import { Event } from "../src/index.ts"
import { makeJournal, run } from "./utils.ts"

const Tenant = Context.Reference<string>(
	"@graftland/graft/test/waterfall-context.test/Tenant",
	{
		defaultValue: () => "default",
	},
)
class Local extends Context.Service<Local, string>()(
	"@graftland/graft/test/waterfall-context.test/Local",
) {}

describe("waterfall callback context", () => {
	it.effect(
		"keeps last in the dispatcher context with or without transparent middleware",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string>("last-context")
				const journal = yield* makeJournal
				const dispatch = Event.waterfall(event, "input", () => Tenant).pipe(
					Effect.provideService(Tenant, "dispatcher"),
				)
				const before = yield* dispatch
				for (const tenant of ["first", "second"]) {
					yield* Event.on(event, (input, next) =>
						Effect.gen(function* () {
							yield* Effect.flatMap(Tenant, journal.record)
							return yield* next(input).pipe(
								Effect.provideService(Tenant, "next override"),
							)
						}),
					).pipe(Effect.provideService(Tenant, tenant))
				}
				const after = yield* dispatch
				assert.strictEqual(before, "dispatcher")
				assert.strictEqual(after, before)
				yield* journal.expect(["first", "second"])
			}).pipe(run),
	)

	it.effect(
		"excludes middleware-only services from last and keeps dispatcher-only services",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, Option.Option<string>>(
					"last-services",
				)
				const owner = yield* Scope.make()
				yield* Event.on(event, (input, next) => next(input)).pipe(
					Effect.provideService(Local, "middleware"),
					Scope.provide(owner),
				)
				const absent = yield* Event.waterfall(event, "input", () =>
					Effect.serviceOption(Local),
				)
				assert.deepStrictEqual(absent, Option.none())
				yield* Scope.close(owner, Exit.void)
				yield* Event.on(event, (input, next) => next(input))
				const provided = yield* Event.waterfall(event, "input", () =>
					Effect.serviceOption(Local),
				).pipe(Effect.provideService(Local, "dispatcher"))
				assert.deepStrictEqual(provided, Option.some("dispatcher"))
			}).pipe(run),
	)

	it.effect(
		"uses dispatcher context when a skipped middleware continues the chain",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string>("skipped-last-context")
				const owner = yield* Scope.make()
				const entered = yield* Deferred.make<void>()
				yield* Event.once(event, () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				).pipe(
					Scope.provide(owner),
					Effect.provideService(Tenant, "middleware"),
				)
				const dispatch = yield* Event.waterfall(
					event,
					"input",
					() => Tenant,
				).pipe(Effect.provideService(Tenant, "dispatcher"), Effect.forkScoped)
				yield* Deferred.await(entered)
				yield* Scope.close(owner, Exit.void)
				const result = yield* Fiber.join(dispatch)
				assert.strictEqual(result, "dispatcher")
			}).pipe(run),
	)
})
