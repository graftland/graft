import { Array, Effect, Exit, Schema } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "../src/index.ts"
import { reach, run } from "./utils.ts"

const quiet = Plugin.make({ name: "quiet", apply: () => Effect.void })
const failing = Plugin.make({
	name: "failing",
	apply: () => Effect.fail("new failure"),
})

const check = <A, E, R>(effect: Effect.Effect<A, E, R>): void =>
	assert.isTrue(Effect.isEffect(effect))

describe("replacement contracts", () => {
	it("rejects new errors and changed inputs independently for each pair", () => {
		// @ts-expect-error The replacement introduces errors the original fork cannot report.
		check(Graft.replace([[quiet, failing]]))
		const narrow = Plugin.make({
			name: "narrow errors",
			apply: () => Effect.fail("one" as const),
		})
		const broad = Plugin.make({
			name: "broad errors",
			apply: (): Effect.Effect<void, "one" | "two"> => Effect.fail("one"),
		})
		check(Graft.replace([[broad, narrow]]))
		// @ts-expect-error Widening a pair's error channel is forbidden.
		check(Graft.replace([[narrow, broad]]))
		const text = Plugin.make({
			name: "text",
			config: Schema.String,
			apply: () => Effect.void,
		})
		const number = Plugin.make({
			name: "number",
			config: Schema.Finite,
			apply: () => Effect.void,
		})
		const literal = Plugin.make({
			name: "literal",
			config: Schema.Literal("one"),
			apply: () => Effect.void,
		})
		const optional = Plugin.make({
			name: "optional",
			config: Schema.UndefinedOr(Schema.String),
			apply: () => Effect.void,
		})
		// @ts-expect-error Input types differ.
		check(Graft.replace([[text, number]]))
		// @ts-expect-error An input subtype is still a different input contract.
		check(Graft.replace([[text, literal]]))
		// @ts-expect-error An input supertype is still a different input contract.
		check(Graft.replace([[text, optional]]))
		check(
			Graft.replace([
				[text, text],
				[number, number],
				[broad, narrow],
			]),
		)
		const mixedErrors = [
			[broad, narrow],
			[quiet, failing],
		] as const
		// @ts-expect-error Another pair cannot widen this pair's accepted errors.
		check(Graft.replace(mixedErrors))
		const swappedInputs = [
			[text, number],
			[number, text],
		] as const
		// @ts-expect-error Another pair cannot hide incompatible input types.
		check(Graft.replace(swappedInputs))
		const pairs: ReadonlyArray<readonly [typeof quiet, typeof failing]> = [
			[quiet, failing],
		]
		// @ts-expect-error Stored pair arrays retain their source contract.
		check(Graft.replace(pairs))
		const unionPairs: ReadonlyArray<
			| readonly [typeof quiet, typeof failing]
			| readonly [typeof failing, typeof quiet]
		> = [[quiet, failing]]
		// @ts-expect-error A compatible union member cannot hide an incompatible pair.
		check(Graft.replace(unionPairs))
		const dynamic: ReadonlyArray<readonly [Plugin.Plugin, Plugin.Plugin]> = [
			[quiet, failing],
		]
		check(Graft.replace(dynamic))
		const replaceUnion = (source: typeof quiet | typeof failing) => {
			// @ts-expect-error Every possible source definition must admit the replacement errors.
			check(Graft.replace([[source, failing]]))
		}
		replaceUnion(quiet)
		// @ts-expect-error Loading a typed definition still rejects an unrelated input.
		check(Graft.plugin(text, 1))
		check(Graft.plugin(quiet))
	})

	it.effect(
		"keeps an existing handle's error bound when a replacement narrows it",
		() =>
			Effect.gen(function* () {
				const original = Plugin.make({
					name: "original",
					apply: (): Effect.Effect<void, "old failure" | "new failure"> =>
						Effect.void,
				})
				const replacement = Plugin.make({
					name: "replacement",
					apply: () => Effect.fail("new failure" as const),
				})
				const fork = yield* Graft.plugin(original)
				yield* fork.await
				yield* Graft.replace([[original, replacement]])
				yield* reach(fork, "Failed")
				const result = yield* Effect.exit(fork.await)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) {
					assert.deepStrictEqual(
						Array.map(result.cause.reasons, (reason) =>
							reason._tag === "Fail" ? reason.error : reason._tag,
						),
						["new failure"],
					)
				}
				const handled: Effect.Effect<void> = fork.await.pipe(
					Effect.catch((error) =>
						Effect.logDebug("Recovered plugin failure", error),
					),
				)
				yield* handled
			}).pipe(run),
	)
})
