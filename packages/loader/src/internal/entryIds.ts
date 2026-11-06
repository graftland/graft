import { Array, Hash, HashMap, HashSet, Option, Result, String } from "effect"

import type { Entry, NewEntry } from "../Entry"

export const EntryDefinition = "Entry"
export const EntriesId = "@graftland/loader/Entries"

export const validateIds = (
	entries: ReadonlyArray<{ readonly id?: string | undefined }>,
	seen: HashSet.HashSet<string> = HashSet.empty(),
): Result.Result<HashSet.HashSet<string>, string> => {
	let unique = seen
	for (const entry of entries) {
		if (entry.id === undefined) continue
		if (HashSet.has(unique, entry.id))
			return Result.fail(`Duplicate entry id "${entry.id}"`)
		unique = HashSet.add(unique, entry.id)
	}
	return Result.succeed(unique)
}

/** Derive identities only from the parent, name and anonymous occurrence, never config. */
export const assignIds = (
	entries: ReadonlyArray<NewEntry>,
	parent: Option.Option<string>,
): ReadonlyArray<Entry> => {
	let used = HashSet.fromIterable(
		Array.flatMap(entries, (entry) =>
			entry.id === undefined ? [] : [entry.id],
		),
	)
	let occurrences = HashMap.empty<string, number>()
	return Array.map(entries, (entry) => {
		if (entry.id !== undefined) return { ...entry, id: entry.id }
		const occurrence = Option.getOrElse(
			HashMap.get(occurrences, entry.name),
			() => 0,
		)
		occurrences = HashMap.set(occurrences, entry.name, occurrence + 1)
		let salt = 0
		const next = () => {
			// @effect-diagnostics-next-line globalJson:off -- This tuple contains only strings, null and finite integers, so serialization cannot fail.
			const key = JSON.stringify([
				Option.getOrNull(parent),
				entry.name,
				occurrence,
				salt++,
			])
			return String.padStart(8, "0")((Hash.string(key) >>> 0).toString(16))
		}
		let id = next()
		while (HashSet.has(used, id)) id = next()
		used = HashSet.add(used, id)
		return { ...entry, id }
	})
}
