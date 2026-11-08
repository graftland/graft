import { Cause, Effect, String } from "effect"
import { assert, it } from "@effect/vitest"

import * as Limit from "../src/internal/encodedLimit"

it.effect(
	"rejects oversized unary messages before dispatch rather than fragmenting an unbounded logical request (I9, I12)",
	() =>
		Effect.gen(function* () {
			const failure = yield* Limit.check({
				data: String.repeat(1024 * 1024)("x"),
			}).pipe(Effect.flip)
			assert.equal(failure.reason, "TooLarge")
		}),
)
it.effect(
	"counts encoded UTF-8 bytes rather than JavaScript characters (I9, I12)",
	() =>
		Effect.gen(function* () {
			const failure = yield* Limit.check({
				data: String.repeat(400000)("界"),
			}).pipe(Effect.flip)
			assert.equal(failure.reason, "TooLarge")
		}),
)
it.effect(
	"preserves an unencodable message Cause without throwing synchronously (I4, I9)",
	() =>
		Effect.gen(function* () {
			const value = { value: 1n }
			const failure = yield* Limit.check(value).pipe(Effect.flip)
			assert.equal(failure.reason, "Encoding")
			assert.isTrue(Cause.hasFails(failure.cause))
		}),
)
