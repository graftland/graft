import { Cause, Effect, HashSet, Option, Stream } from "effect"
import { assert } from "@effect/vitest"

import type * as Kernel from "@graftland/graft/Kernel"

import type * as Control from "../src/Control"

export const phase = (
	client: Control.Client,
	id: string,
	value: Kernel.Phase,
) =>
	client.observe(id).pipe(
		Stream.filter(
			(s) =>
				s.phase === value || (value === "Retiring" && s.phase === "Concluded"),
		),
		Stream.runHead,
		Effect.flatMap(Effect.fromOption),
	)
export const consistent = Effect.fnUntraced(function* (
	client: Control.Client,
	id: string,
	expected: Kernel.Outcome,
) {
	const result = yield* client.handle(id).await
	assert.equal(result.outcome, expected, Cause.pretty(result.cause))
	const status = yield* client.get(id).pipe(Effect.flatMap(Effect.fromOption))
	assert.deepEqual(Option.getOrThrow(status.conclusion), result)
	const repeated = yield* client.handle(id).await
	assert.deepEqual(repeated, result)
	assert.equal(HashSet.size(status.unconfirmedUnits), 0)
	assert.equal(HashSet.size(status.leaseHolders), 0)
	return result
})
