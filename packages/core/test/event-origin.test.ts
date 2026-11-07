import { Context, Effect, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import { Event } from "../src/index.ts"
import { run } from "./utils.ts"

const Label = Context.Reference<string>("test/origin-label", {
	defaultValue: () => "default",
})
class Secret extends Context.Service<Secret, { readonly value: string }>()(
	"@graftland/graft/test/event-origin.test/Secret",
) {}

it.effect(
	"origin membership propagates through nested dispatches without matching another token",
	() =>
		Effect.gen(function* () {
			const origin = Event.makeOrigin()
			const other = Event.makeOrigin()
			const outer = Event.make<[]>("test/outer")
			const inner = Event.make<[]>("test/inner")
			const seen = yield* Ref.make<ReadonlyArray<boolean>>([])
			yield* Event.on(inner, () =>
				Effect.gen(function* () {
					const member = yield* Event.isWithin(origin)
					const unrelated = yield* Event.isWithin(other)
					assert.isFalse(unrelated)
					yield* Ref.update(seen, (values) => [...values, member])
				}),
			)
			yield* Event.on(outer, () => Event.emit(inner))
			yield* Event.emit(outer).pipe(Event.within(origin))
			yield* Event.emit(outer)
			const memberships = yield* Ref.get(seen)
			assert.deepStrictEqual(memberships, [true, false])
		}).pipe(run),
)

it.effect(
	"origin propagation does not expose the caller's private services or context",
	() =>
		Effect.gen(function* () {
			const origin = Event.makeOrigin()
			const outer = Event.make<[]>("test/private-outer")
			const inner = Event.make<[]>("test/private-inner")
			const secret = { value: "private to the dispatcher" }
			const inspect = Effect.gen(function* () {
				const context = yield* Effect.context<never>()
				assert.isUndefined(Context.getOrUndefined(context, Secret))
				assert.equal(Context.get(context, Label), "handler")
				// Even enumerating the public Context map reveals no caller Context or secret value.
				for (const value of context.mapUnsafe.values()) {
					assert.notStrictEqual(value, secret)
					if (Context.isContext(value))
						assert.isUndefined(Context.getOrUndefined(value, Secret))
				}
				const member = yield* Event.isWithin(origin)
				assert.isTrue(member)
			})
			yield* Event.on(inner, () => inspect).pipe(
				Effect.provideService(Label, "handler"),
			)
			yield* Event.on(outer, () =>
				inspect.pipe(Effect.andThen(Event.emit(inner))),
			).pipe(Effect.provideService(Label, "handler"))
			yield* Event.emit(outer).pipe(
				Event.within(origin),
				Effect.provideService(Label, "dispatcher"),
				Effect.provideService(Secret, secret),
			)
		}).pipe(run),
)

it.effect(
	"nested origins restore membership and registration does not retain an origin",
	() =>
		Effect.gen(function* () {
			const first = Event.makeOrigin()
			const second = Event.makeOrigin()
			const event = Event.make<[]>("test/registered-origin")
			yield* Event.on(event, () =>
				Effect.gen(function* () {
					const active = yield* Event.isWithin(first)
					assert.isFalse(active)
				}),
			).pipe(Event.within(first))
			yield* Event.emit(event)
			yield* Effect.gen(function* () {
				const inner = yield* Effect.all([
					Event.isWithin(first),
					Event.isWithin(second),
				]).pipe(Event.within(second))
				assert.deepStrictEqual(inner, [true, true])
				const restored = yield* Effect.all([
					Event.isWithin(first),
					Event.isWithin(second),
				])
				assert.deepStrictEqual(restored, [true, false])
			}).pipe(Event.within(first))
			const outside = yield* Effect.all([
				Event.isWithin(first),
				Event.isWithin(second),
			])
			assert.deepStrictEqual(outside, [false, false])
		}).pipe(run),
)

it.effect(
	"waterfall preserves origins through next while restoring dispatcher services",
	() =>
		Effect.gen(function* () {
			const origin = Event.makeOrigin()
			const event = Event.middleware<void, boolean>("test/origin-waterfall")
			yield* Event.on(event, (input, next) =>
				next(input).pipe(
					Event.within(origin),
					Effect.provideService(Label, "middleware"),
				),
			)
			yield* Event.on(event, (input, next) =>
				Effect.gen(function* () {
					const member = yield* Event.isWithin(origin)
					assert.isTrue(member)
					return yield* next(input)
				}),
			)
			const member = yield* Event.waterfall(event, undefined, () =>
				Effect.gen(function* () {
					const label = yield* Label
					assert.equal(label, "dispatcher")
					return yield* Event.isWithin(origin)
				}),
			).pipe(Effect.provideService(Label, "dispatcher"))
			assert.isTrue(member)
		}).pipe(run),
)
