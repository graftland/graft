import { Effect, Equal, Result } from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Change from "../src/Change.ts"
import { normalize } from "../src/internal/changeRequest.ts"

const candidate: Change.Candidate = {
	driver: "fixture",
	identity: "next",
	deployment: { config: "next" },
}
const request: Change.Request = { instance: "a", candidate }

describe("Change request normalization", () => {
	it.effect(
		"normalizes duration inputs defaults and absent optional fields",
		() =>
			Effect.gen(function* () {
				const left = yield* normalize(request)
				const right = yield* normalize({
					...request,
					key: "retry",
					expected: undefined,
					strategy: undefined,
					budget: { startup: "30 seconds", probe: "5 seconds" },
					requirements: { trial: "0 seconds", probes: [] },
				})
				assert.isTrue(Equal.equals(left, right))
			}),
	)

	it.effect(
		"includes expected versions and desired deployments in key equality",
		() =>
			Effect.gen(function* () {
				const base = yield* normalize({ ...request, expected: 1 })
				const newer = yield* normalize({ ...request, expected: 2 })
				const other = yield* normalize({
					...request,
					expected: 1,
					candidate: { ...candidate, deployment: { config: "other" } },
				})
				assert.isFalse(Equal.equals(base, newer))
				assert.isFalse(Equal.equals(base, other))
			}),
	)

	it.effect(
		"reserves both the forward and recovery trial in the total budget",
		() =>
			Effect.gen(function* () {
				const normalized = yield* normalize(request)
				const trial = normalized.budget.total
				const result = yield* Effect.result(
					normalize({ ...request, requirements: { trial } }),
				)
				assert.isTrue(Result.isFailure(result))
				if (Result.isFailure(result))
					assert.strictEqual(result.failure._tag, "ChangeRejected")
			}),
	)

	it.effect("rejects invalid finite budgets before admission", () =>
		Effect.gen(function* () {
			for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
				const result = yield* Effect.result(
					normalize({ ...request, budget: { total } }),
				)
				assert.isTrue(Result.isFailure(result))
			}
		}),
	)
})
