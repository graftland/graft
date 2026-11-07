import { Array, Effect, Option } from "effect"

import type { Change, Entry, Release } from "../Model"
import { equal } from "./storage"

export const reasons = Effect.fnUntraced(function* (
	before: Option.Option<Entry>,
	entry: Entry,
): Effect.fn.Return<Change["reasons"], import("effect").Schema.SchemaError> {
	if (Option.isNone(before)) return ["added"]
	const code = !(yield* equal(before.value.artifact, entry.artifact))
	const config =
		!(yield* equal(before.value.input, entry.input)) ||
		!(yield* equal(before.value.probes, entry.probes)) ||
		before.value.contract !== entry.contract ||
		!(yield* equal(before.value.target, entry.target))
	return [
		...(code ? ["code" as const] : []),
		...(config ? ["config" as const] : []),
	]
})

export const changes = Effect.fnUntraced(function* (
	before: Release,
	next: Release,
) {
	const inspected = yield* Effect.forEach(
		next.entries,
		Effect.fnUntraced(function* (entry) {
			const why = yield* reasons(
				Array.findFirst(before.entries, (old) => old.id === entry.id),
				entry,
			)
			return why.length === 0 ? [] : [{ entry: entry.id, reasons: why }]
		}),
	)
	return [
		...Array.flatten(inspected),
		...Array.map(
			Array.filter(
				before.entries,
				(old) => !Array.some(next.entries, (entry) => entry.id === old.id),
			),
			(old): Change => ({ entry: old.id, reasons: ["removed"] }),
		),
	]
})
