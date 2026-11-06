import {
	Array,
	Cause,
	Effect,
	Exit,
	HashMap,
	HashSet,
	Option,
	Record,
	Schema,
} from "effect"

import { Event } from "@graftland/graft"

import * as Extensions from "../Extensions"

export const same = Schema.toEquivalence(Schema.Unknown)
export const snapshot = Effect.gen(function* () {
	const outcomes = yield* Event.settle(Extensions.Declared)
	const failures = Array.flatMap(outcomes, (outcome) =>
		Exit.isFailure(outcome) && !Cause.hasInterruptsOnly(outcome.cause)
			? [outcome.cause]
			: [],
	)
	let values = HashMap.empty<string, unknown>()
	let conflicts = HashSet.empty<string>()
	for (const outcome of outcomes) {
		if (Exit.isFailure(outcome)) continue
		for (const [key, value] of Record.toEntries(outcome.value)) {
			const prior = HashMap.get(values, key)
			if (Option.isSome(prior) && !same(prior.value, value))
				conflicts = HashSet.add(conflicts, key)
			else values = HashMap.set(values, key, value)
		}
	}
	for (const key of conflicts) {
		values = HashMap.remove(values, key)
	}
	return {
		values: Record.fromEntries(Array.fromIterable(values)),
		failures,
		conflicts: Array.map(Array.fromIterable(conflicts), (key) => ({
			key,
			values: Array.flatMap(outcomes, (outcome) =>
				Exit.isSuccess(outcome) && key in outcome.value
					? [outcome.value[key]]
					: [],
			),
		})),
	}
})
