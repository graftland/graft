import { Array as Arr, Equal, HashMap, HashSet, Option } from "effect"
import { assert } from "@effect/vitest"

import * as Core from "../../src/internal/decisionCore.ts"

export const capacity = (s: Core.State): void => {
	const c = Core.capacity(s)
	assert.isAtLeast(c.used, 0)
	assert.isAtLeast(c.reserved, 0)
	assert.isAtMost(c.used + c.reserved, s.maxUnits)
	assert.strictEqual(c.used + c.reserved, HashMap.size(s.claims))
	for (const [id, unit] of s.units) {
		if (unit.evidence === "Missing") {
			const claim = Option.getOrThrow(HashMap.get(s.claims, unit.claim))
			assert.strictEqual(claim.owner, unit.owner)
			const owner = HashMap.get(s.changes, unit.owner)
			if (Option.isSome(owner)) assert.isFalse(owner.value.released)
			assert.isTrue(Option.contains(claim.unit, id))
		}
	}
}

export const invariant = (s: Core.State): void => {
	capacity(s)
	for (const [key, cell] of s.cells) {
		if (Option.isSome(cell.writer)) {
			assert.strictEqual(
				HashSet.size(cell.readers),
				0,
				"A writer excludes readers",
			)
			const c = Option.getOrThrow(HashMap.get(s.changes, cell.writer.value))
			assert.isFalse(c.released)
			assert.isTrue(HashSet.has(c.request.writes, key))
		}
	}
	for (const c of HashMap.values(s.changes)) {
		for (const key of c.request.writes)
			assert.strictEqual(
				Option.contains(Core.cell(s, key).writer, c.id),
				!c.released,
			)
		for (const [key] of c.request.reads)
			if (!HashSet.has(c.request.writes, key))
				assert.strictEqual(
					HashSet.has(Core.cell(s, key).readers, c.id),
					!c.released,
				)
		if (c.released)
			assert.isFalse(
				HashSet.some(
					c.requiredExits,
					(id) =>
						Option.getOrThrow(HashMap.get(s.units, id)).evidence === "Missing",
				),
			)
		if (Option.exists(c.conclusion, (o) => o.outcome === "Aborted"))
			assert.isFalse(c.oldChanged)
	}
	for (const unit of HashMap.values(s.units))
		if (unit.evidence !== "Missing")
			assert.strictEqual(HashSet.size(unit.leases), 0)
}
export const checked = (
	s: Core.State,
	event: Core.Event,
	trace: ReadonlyArray<string> = [],
): Core.Transition => {
	const next = Core.reduce(s, event)
	const label = Arr.join(trace, " -> ")
	invariant(next.state)
	for (const [id, old] of s.changes) {
		const current = Option.getOrThrow(HashMap.get(next.state.changes, id))
		if (Option.isSome(old.conclusion))
			assert.strictEqual(current.conclusion, old.conclusion, label)
		assert.isAtLeast(current.sequence, old.sequence, label)
	}
	for (const [key, old] of s.cells)
		assert.isAtLeast(Core.cell(next.state, key).version, old.version, label)
	for (const [id, old] of s.units)
		if (old.evidence !== "Missing")
			assert.isTrue(
				Equal.equals(old, Option.getOrThrow(HashMap.get(next.state.units, id))),
				label,
			)
	if (next.reply._tag === "Rejected") {
		assert.isTrue(Equal.equals(s.claims, next.state.claims), label)
		assert.isTrue(Equal.equals(s.cells, next.state.cells), label)
	}
	return next
}
