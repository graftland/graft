import {
	Array,
	Cause,
	Data,
	Effect,
	HashMap,
	HashSet,
	Option,
	Result,
} from "effect"
import {
	StateStorageError,
	keyOf,
	type SessionKey,
	type SessionRecord,
} from "./model"

/** A terminal high-water record fences every older Open, even after its request id is forgotten. */
export const retain = (
	records: ReadonlyArray<SessionRecord>,
): ReadonlyArray<SessionRecord> => {
	const highWater = Array.reduce(
		records,
		HashMap.empty<SessionKey, number>(),
		(water, record) =>
			HashMap.set(
				water,
				keyOf(record.handle.key),
				Math.max(
					Option.getOrElse(
						HashMap.get(water, keyOf(record.handle.key)),
						() => 0,
					),
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
class Generation extends Data.Class<{
	readonly key: SessionKey
	readonly value: number
}> {}
class Request extends Data.Class<{
	readonly key: SessionKey
	readonly value: string
}> {}
interface Seen {
	readonly tokens: HashSet.HashSet<string>
	readonly generations: HashSet.HashSet<Generation>
	readonly requests: HashSet.HashSet<Request>
}
const empty: Seen = {
	tokens: HashSet.empty(),
	generations: HashSet.empty(),
	requests: HashSet.empty(),
}
/** Validate the complete history before applying retention, including records that will be removed. */
const initial: Result.Result<Seen, StateStorageError> = Result.succeed(empty)
export const validate = (records: ReadonlyArray<SessionRecord>) =>
	Effect.fromResult(
		Array.reduce(records, initial, (result, record) =>
			Result.flatMap(result, (seen) => {
				if (
					!Number.isSafeInteger(record.handle.generation) ||
					record.handle.generation <= 0 ||
					record.leaseMillis <= 0
				)
					return Result.fail(
						StateStorageError.make({
							detail: "Invalid generation or lease in runner state",
							cause: Cause.empty,
						}),
					)
				const key = keyOf(record.handle.key)
				const generation = new Generation({
					key,
					value: record.handle.generation,
				})
				const request = new Request({ key, value: record.requestId })
				if (
					HashSet.has(seen.tokens, record.handle.token) ||
					HashSet.has(seen.generations, generation) ||
					HashSet.has(seen.requests, request)
				)
					return Result.fail(
						StateStorageError.make({
							detail:
								"Duplicate generation, session token, or Open request in runner state",
							cause: Cause.empty,
						}),
					)
				return Result.succeed({
					tokens: HashSet.add(seen.tokens, record.handle.token),
					generations: HashSet.add(seen.generations, generation),
					requests: HashSet.add(seen.requests, request),
				})
			}),
		),
	).pipe(Effect.asVoid)
