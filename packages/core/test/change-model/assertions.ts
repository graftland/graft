import { Array as Arr, Equal, HashMap, HashSet, Option } from "effect"
import { assert } from "@effect/vitest"

// Kept separate from scenarios: adapters can reuse actions and this observer.
import {
	cell,
	change,
	generation,
	step,
	type Action,
	type Model,
	type Outcome,
	type Step,
} from "./model.ts"

export const conclusion = (
	state: Model,
	id: string,
	outcome: Outcome,
): void => {
	const c = change(state, id)
	assert.isTrue(Option.isSome(c.conclusion), `${id} has no conclusion`)
	const value = Option.getOrThrow(c.conclusion)
	assert.strictEqual(value.outcome, outcome)
	assert.strictEqual(HashMap.size(value.members), HashMap.size(c.plan.members))
	if (outcome === "Accepted")
		assert.isTrue(
			HashMap.every(
				value.members,
				(fact) => fact.matchesTarget && fact.healthy,
			),
		)
	if (outcome === "Aborted")
		assert.isTrue(
			HashMap.every(
				value.members,
				(fact) => Equal.equals(fact.start, fact.current) && fact.healthy,
			),
		)
	if (outcome !== "Accepted") assert.isAbove(value.cause.reasons.length, 0)
}

// This observer scans the entire small world on purpose. It is an independent
// oracle and is excluded from the protocol's access accounting.
export const invariant = (state: Model): void => {
	assert.isAtLeast(state.capacity.used, 0)
	assert.isAtLeast(state.capacity.reserved, 0)
	assert.isAtMost(state.capacity.used + state.capacity.reserved, state.maxUnits)
	for (const [key, lock] of state.reservations) {
		assert.isTrue(
			Option.isNone(lock.writer) || HashSet.size(lock.readers) === 0,
			"A writer excludes all other reservations",
		)
		if (Option.isSome(lock.writer))
			assert.isTrue(
				HashSet.has(change(state, lock.writer.value).plan.writes, key),
			)
	}
	for (const c of HashMap.values(state.changes)) {
		const retained = !c.reservationsReleased
		for (const key of c.plan.writes) {
			const lock = Option.getOrThrow(HashMap.get(state.reservations, key))
			assert.strictEqual(
				Option.contains(lock.writer, c.plan.id),
				retained,
				"The full write set stays reserved through settlement",
			)
		}
		for (const key of HashMap.keys(c.plan.reads)) {
			if (HashSet.has(c.plan.writes, key)) continue
			const lock = Option.getOrThrow(HashMap.get(state.reservations, key))
			assert.strictEqual(HashSet.has(lock.readers, c.plan.id), retained)
		}
		if (Option.isSome(c.conclusion))
			assert.strictEqual(
				HashMap.size(c.conclusion.value.members),
				HashMap.size(c.plan.members),
			)
		if (
			c.reservationsReleased &&
			Option.exists(c.conclusion, (v) => v.outcome === "Stuck")
		)
			assert.isTrue(
				HashSet.every(c.settlement, (id) => generation(state, id).retired),
			)
	}
	for (const gen of HashMap.values(state.generations)) {
		if (gen.retired) {
			assert.notStrictEqual(gen.evidence, "Missing")
			assert.strictEqual(
				HashSet.size(gen.leases),
				0,
				"A retired generation cannot hold leases",
			)
			assert.strictEqual(
				HashSet.size(
					Option.getOrElse(HashMap.get(state.leaseHolders, gen.id), () =>
						HashSet.empty(),
					),
				),
				0,
				"A leased generation cannot retire",
			)
		}
		for (const provider of gen.leases) {
			assert.isFalse(generation(state, provider).retired)
			assert.isTrue(
				HashSet.has(
					Option.getOrThrow(HashMap.get(state.leaseHolders, provider)),
					gen.id,
				),
			)
		}
	}
	for (const [provider, holders] of state.leaseHolders) {
		for (const holder of holders)
			assert.isTrue(HashSet.has(generation(state, holder).leases, provider))
	}
}

export const transition = (
	before: Model,
	action: Action,
	after: Step,
	trace: ReadonlyArray<Action>,
): void => {
	const label = Arr.join(
		Arr.map(trace, (a) => a._tag),
		" -> ",
	)
	invariant(after.state)
	for (const [key, old] of before.cells)
		assert.isAtLeast(cell(after.state, key).version, old.version, label)
	for (const [id, old] of before.generations) {
		const current = generation(after.state, id)
		assert.isTrue(
			Equal.equals(old.resolution, current.resolution),
			"Resolution belongs to a generation",
		)
		assert.strictEqual(
			old.owner,
			current.owner,
			"Generation ownership never transfers",
		)
		assert.isTrue(
			!old.retired || current.retired,
			"Retirement cannot be undone",
		)
	}
	for (const [id, old] of before.changes) {
		if (Option.isSome(old.conclusion))
			assert.isTrue(
				Equal.equals(old.conclusion, change(after.state, id).conclusion),
				"A recorded conclusion is immutable",
			)
	}
	if (action._tag === "Submit" && after.decision !== "Applied")
		assert.isTrue(
			Equal.equals(before.reservations, after.state.reservations),
			"Rejected admission cannot retain a partial reservation",
		)
	if (action._tag === "Acknowledge" && after.decision === "RejectedAck")
		assert.isTrue(Equal.equals(before.cells, after.state.cells))
	if (action._tag === "Submit" || action._tag === "Commit") {
		const p =
			action._tag === "Submit"
				? action.plan
				: Option.map(
						HashMap.get(before.changes, action.change),
						(c) => c.plan,
					).pipe(Option.getOrUndefined)
		if (p !== undefined) {
			const allowed = HashSet.union(
				p.writes,
				HashSet.fromIterable(HashMap.keys(p.reads)),
			)
			for (const [key, count] of after.state.accesses) {
				if (
					count > Option.getOrElse(HashMap.get(before.accesses, key), () => 0)
				)
					assert.isTrue(
						key._tag === "Generation"
							? HashSet.has(p.participants, key.id) ||
									HashMap.has(
										p.members,
										generation(after.state, key.id).instance,
									)
							: HashSet.has(allowed, key),
						"Unrelated object was accessed",
					)
			}
		}
	}
}

export const run = (initial: Model, actions: ReadonlyArray<Action>): Model =>
	Arr.reduce(actions, initial, (before, action) => {
		const after = stepChecked(before, action)
		return after.state
	})

export const stepChecked = (before: Model, action: Action): Step => {
	const after = step(before, action)
	transition(before, action, after, [action])
	return after
}
