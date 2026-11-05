import { Array, HashMap, Option } from "effect"

import { keyOf, type SessionKey, type SessionRecord } from "./model"

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
/** Apply the same retention rule to both in-memory stores. */
export const save = (
	records: HashMap.HashMap<string, SessionRecord>,
	record: SessionRecord,
) =>
	HashMap.fromIterable(
		Array.map(
			retain(
				Array.fromIterable(
					HashMap.values(HashMap.set(records, record.handle.token, record)),
				),
			),
			(record): readonly [string, SessionRecord] => [
				record.handle.token,
				record,
			],
		),
	)
