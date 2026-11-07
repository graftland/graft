import { Array, Effect, Exit, Ref, Scope } from "effect"
import { assert, it } from "@effect/vitest"

import { Event } from "../src/index.ts"
import { run } from "./utils.ts"

it.effect(
	"orders every dispatch while retaining prepend and registration ties",
	() =>
		Effect.gen(function* () {
			const event = Event.make<[], string>("test/order")
			const seen = yield* Ref.make<ReadonlyArray<string>>([])
			for (const [name, options] of [
				["late", { order: 10 }],
				["first", {}],
				["early", { order: -10 }],
				["second", {}],
				["prepended", { prepend: true }],
			] as const) {
				yield* Event.on(
					event,
					() => Ref.update(seen, (xs) => [...xs, name]).pipe(Effect.as(name)),
					options,
				)
			}
			const expected = ["early", "prepended", "first", "second", "late"]
			yield* Event.emit(event)
			const emitted = yield* Ref.get(seen)
			assert.deepStrictEqual(emitted, expected)
			const parallel = yield* Event.parallel(event)
			assert.deepStrictEqual(parallel, expected)
			const settled = yield* Event.settle(event)
			assert.deepStrictEqual(
				Array.map(settled, (exit) => (Exit.isSuccess(exit) ? exit.value : "")),
				expected,
			)
		}).pipe(run),
)

it.effect("keeps middleware nesting stable after a handler reload", () =>
	Effect.gen(function* () {
		const event = Event.middleware<string, string>("test/ordered-middleware")
		const register = (name: string, order: number) =>
			Event.on(
				event,
				(value, next) =>
					next(value + name).pipe(Effect.map((out) => out + name)),
				{ order },
			)
		const owner = yield* Scope.make()
		yield* register("a", -10).pipe(Scope.provide(owner))
		yield* register("b", 10)
		const invoke = Event.waterfall(event, "", Effect.succeed)
		const before = yield* invoke
		assert.strictEqual(before, "abba")
		yield* Scope.close(owner, Exit.void)
		yield* register("a", -10)
		const after = yield* invoke
		assert.strictEqual(after, "abba")
	}).pipe(run),
)
