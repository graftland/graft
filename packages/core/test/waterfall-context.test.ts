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
import { assert, describe, it } from "@effect/vitest"

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
		"interrupts the chain when a running middleware closes before next",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string>(
					"interrupted-before-next",
				)
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
				const result = yield* Fiber.await(dispatch)
				assert.isTrue(
					Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause),
				)
			}).pipe(run),
	)
	it.effect(
		"keeps the dispatcher context when an unclaimed middleware is removed",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string>("unclaimed-context")
				const owner = yield* Scope.make()
				yield* Event.on(event, (input, next) =>
					Scope.close(owner, Exit.void).pipe(Effect.andThen(next(input))),
				).pipe(Effect.provideService(Tenant, "outer"))
				yield* Event.on(event, () => Effect.die("Removed handler ran")).pipe(
					Scope.provide(owner),
					Effect.provideService(Tenant, "removed"),
				)
				const result = yield* Event.waterfall(
					event,
					"input",
					() => Tenant,
				).pipe(Effect.provideService(Tenant, "dispatcher"))
				assert.strictEqual(result, "dispatcher")
			}).pipe(run),
	)

	it.effect(
		"interrupts during post-processing instead of returning the downstream success",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string>("post-processing")
				const owner = yield* Scope.make()
				const entered = yield* Deferred.make<void>()
				yield* Event.on(event, (input, next) =>
					next(input).pipe(
						Effect.andThen(Deferred.succeed(entered, undefined)),
						Effect.andThen(Effect.never),
					),
				).pipe(Scope.provide(owner))
				const dispatch = yield* Event.waterfall(
					event,
					"raw secret",
					Effect.succeed,
				).pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				yield* Scope.close(owner, Exit.void)
				const result = yield* Fiber.await(dispatch)
				assert.isTrue(
					Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause),
				)
			}).pipe(run),
	)
})
