import { assert, describe, it } from "@effect/vitest"
import { Array, Effect, Equal, Hash, Option, Result, Stream } from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { run } from "./utils.ts"

const names = Graft.forks.pipe(
	Stream.runHead,
	Effect.map((snapshot) =>
		Array.map(Option.getOrThrow(snapshot), (node) => node.name),
	),
)
const make = (name: string) => Plugin.make({ name, apply: () => Effect.void })

describe("definition object identity", () => {
	it.effect(
		"does not replace a separate definition created with object spread",
		() =>
			Effect.gen(function* () {
				const base = make("original")
				const first = { ...base }
				const sibling = { ...base }
				assert.notStrictEqual(first, sibling)
				assert.isTrue(Plugin.isPlugin(first) && Plugin.isPlugin(sibling))
				const existing = yield* Graft.plugin(sibling)
				yield* existing.await
				yield* Graft.replace([[first, make("replacement")]])
				// Restart acknowledges any incorrectly published replacement of the sibling.
				yield* existing.restart
				yield* existing.await
				const later = yield* Graft.plugin(sibling)
				yield* later.await
				const replaced = yield* Graft.plugin(first)
				yield* replaced.await
				const actual = yield* names
				assert.deepStrictEqual(actual, ["original", "original", "replacement"])
			}).pipe(run),
	)

	it.effect("replaces equal-looking sources independently in one batch", () =>
		Effect.gen(function* () {
			const base = make("original")
			const first = { ...base }
			const second = { ...base }
			yield* Graft.replace([
				[first, make("first replacement")],
				[second, make("second replacement")],
			])
			for (const definition of [first, second, base]) {
				const fork = yield* Graft.plugin(definition)
				yield* fork.await
			}
			const actual = yield* names
			assert.deepStrictEqual(actual, [
				"first replacement",
				"second replacement",
				"original",
			])
		}).pipe(run),
	)

	it.effect(
		"does not remove another object's alias when its equal-looking copy becomes a target",
		() =>
			Effect.gen(function* () {
				const base = make("original")
				const aliased = { ...base }
				const target = { ...base }
				const source = make("source")
				yield* Graft.replace([[aliased, make("earlier replacement")]])
				yield* Graft.replace([[source, target]])
				for (const definition of [aliased, source, target]) {
					const fork = yield* Graft.plugin(definition)
					yield* fork.await
				}
				const actual = yield* names
				assert.deepStrictEqual(actual, [
					"earlier replacement",
					"original",
					"original",
				])
			}).pipe(run),
	)

	it.effect(
		"redirects copied definitions through later versions and rollback by reference",
		() =>
			Effect.gen(function* () {
				const base = make("original")
				const first = { ...base }
				const second = { ...base }
				const sibling = { ...base }
				const third = make("third")
				const existing = yield* Graft.plugin(first)
				yield* existing.await
				yield* Graft.replace([[first, second]])
				yield* Graft.replace([[second, third]])
				yield* existing.restart
				yield* existing.await
				for (const definition of [first, second, sibling]) {
					const fork = yield* Graft.plugin(definition)
					yield* fork.await
				}
				const upgraded = yield* names
				assert.deepStrictEqual(upgraded, [
					"third",
					"third",
					"third",
					"original",
				])
				yield* Graft.replace([[third, first]])
				yield* existing.restart
				yield* existing.await
				for (const definition of [first, second, third]) {
					const fork = yield* Graft.plugin(definition)
					yield* fork.await
				}
				const rolledBack = yield* names
				assert.deepStrictEqual(rolledBack, Array.replicate("original", 7))
			}).pipe(run),
	)

	it.effect(
		"rejects divergent targets for repeated references without changing aliases",
		() =>
			Effect.gen(function* () {
				const source = { ...make("original") }
				const same = source
				const outcome = yield* Effect.result(
					Graft.replace([
						[source, make("left")],
						[same, make("right")],
					]),
				)
				assert.isTrue(Result.isFailure(outcome))
				if (Result.isFailure(outcome))
					assert.strictEqual(outcome.failure._tag, "ReplacementConflict")
				const fork = yield* Graft.plugin(source)
				yield* fork.await
				const actual = yield* names
				assert.deepStrictEqual(actual, ["original"])
			}).pipe(run),
	)

	it.effect(
		"ignores a definition's custom equality and hashing protocols",
		() =>
			Effect.gen(function* () {
				const base = {
					...make("original"),
					[Equal.symbol]: () => true,
					[Hash.symbol]: () => 0,
				}
				const first = Object.freeze({ ...base })
				const sibling = Object.freeze({ ...base })
				assert.isTrue(Equal.equals(first, sibling))
				yield* Graft.replace([[first, make("replacement")]])
				for (const definition of [first, sibling]) {
					const fork = yield* Graft.plugin(definition)
					yield* fork.await
				}
				const actual = yield* names
				assert.deepStrictEqual(actual, ["replacement", "original"])
				// Runtime identity must not alter equality in the caller's own collections.
				assert.isTrue(Equal.equals(first, sibling))
			}).pipe(run),
	)
})
