import { Array, Effect, HashMap, HashSet, Option } from "effect"
import { failure, keyOf, type Record } from "./model"

/** A terminal high-water record fences every older Open, even after its request id is forgotten. */
export const retain = (
	records: ReadonlyArray<Record>,
): ReadonlyArray<Record> => {
	const highWater = Array.reduce(
		records,
		HashMap.empty<string, number>(),
		(water, record) =>
			HashMap.set(
				water,
				keyOf(record.handle.key),
				Math.max(
					Option.getOrUndefined(HashMap.get(water, keyOf(record.handle.key))) ??
						0,
					record.handle.generation,
				),
			),
	)
	return Array.filter(
		records,
		(record) =>
			record.phase !== "Stopped" ||
			record.handle.generation ===
				Option.getOrUndefined(HashMap.get(highWater, keyOf(record.handle.key))),
	)
}

/** Validate before discarding records: compaction must not conceal corrupt historical state. */
export const validate = (records: ReadonlyArray<Record>) =>
	Effect.gen(function* () {
		let tokens = HashSet.empty<string>()
		let generations = HashSet.empty<string>()
		let requests = HashSet.empty<string>()
		for (const record of records) {
			if (
				!Number.isSafeInteger(record.handle.generation) ||
				record.handle.generation <= 0 ||
				!Number.isFinite(record.leaseMillis) ||
				record.leaseMillis <= 0 ||
				(record.phase === "Stopped" && record.termination === undefined)
			)
				return yield* failure(
					"Storage",
					"Invalid generation, lease, or terminal result in runner state",
				)
			const namespace = keyOf(record.handle.key)
			const prefix = `${namespace.length}:${namespace}`
			const generation = prefix + record.handle.generation
			const request = prefix + record.requestId
			if (
				HashSet.has(tokens, record.handle.token) ||
				HashSet.has(generations, generation) ||
				HashSet.has(requests, request)
			)
				return yield* failure(
					"Storage",
					"Duplicate generation, session token, or Open request in runner state",
				)
			tokens = HashSet.add(tokens, record.handle.token)
			generations = HashSet.add(generations, generation)
			requests = HashSet.add(requests, request)
		}
	})
