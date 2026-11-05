import type { Entry } from "../Entry"
import { snapshot } from "./snapshot"

/** Identity evidence belongs only to snapshots produced by the validation boundary. */
export const trees = new WeakSet<object>()
export const groups = new WeakSet<object>()
export const structures = new WeakSet<object>()

/** A request owns its outer array while retaining validated descendants. */
export const copyGroup = (
	entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> => {
	const copy = snapshot([...entries])
	if (groups.has(entries)) groups.add(copy)
	if (structures.has(entries)) structures.add(copy)
	return copy
}
