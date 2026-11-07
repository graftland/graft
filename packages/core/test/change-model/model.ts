import { Array as Arr, Cause, Data, HashMap, HashSet, Option } from "effect"

// This is a finite protocol model, not an implementation of the runtime.
export type ObjectKey = Data.TaggedEnum<{
	Instance: { readonly id: string }
	Slot: { readonly realm: string; readonly key: string }
	Edge: { readonly consumer: string; readonly provider: string }
	Group: { readonly id: string }
	Generation: { readonly id: string }
}>
export const ObjectKey = Data.taggedEnum<ObjectKey>()
export type Phase =
	| "Admitted"
	| "Prepared"
	| "Installed"
	| "Switched"
	| "Cancelling"
	| "Recovering"
	| "Restored"
	| "Failed"
	| "Settled"
export type Outcome =
	"Accepted" | "Aborted" | "Recovered" | "RecoveryFailed" | "Stuck"
export interface Cell {
	readonly version: number
	readonly value: Option.Option<string>
}
export interface Generation {
	readonly id: string
	readonly instance: string
	readonly config: string
	readonly owner: string
	readonly publications: HashSet.HashSet<ObjectKey>
	readonly started: boolean
	readonly resolution: HashMap.HashMap<ObjectKey, string>
	readonly leases: HashSet.HashSet<string>
	readonly evidence: "Missing" | "Exited" | "NotStarted"
	readonly retired: boolean
	readonly cleanup: "Unknown" | "Completed"
	readonly exitCause: Cause.Cause<string>
}
export interface Member {
	readonly instance: string
	readonly old: string
	readonly target: string
	readonly startHealthy: boolean
	readonly group: string
	readonly publications: HashSet.HashSet<ObjectKey>
	readonly dependencies: HashMap.HashMap<
		ObjectKey,
		{ readonly provider: string; readonly optional: boolean }
	>
}
export interface Plan {
	readonly id: string
	readonly members: HashMap.HashMap<string, Member>
	readonly reads: HashMap.HashMap<ObjectKey, Cell>
	readonly writes: HashSet.HashSet<ObjectKey>
	readonly strategy: "Overlap" | "Restart"
	readonly participants: HashSet.HashSet<string>
}
export interface Reservation {
	readonly writer: Option.Option<string>
	readonly readers: HashSet.HashSet<string>
}
export interface Token {
	readonly change: string
	readonly generation: string
	readonly view: number
}
export interface View {
	readonly version: number
	readonly generations: HashMap.HashMap<string, string>
	readonly patch: HashMap.HashMap<ObjectKey, Option.Option<string>>
	readonly acknowledgements: HashSet.HashSet<string>
	readonly recovery: boolean
	readonly required: HashSet.HashSet<string>
}
export interface MemberFact {
	readonly start: Cell
	readonly startHealthy: boolean
	readonly termination: HashMap.HashMap<
		string,
		{
			readonly evidence: Generation["evidence"]
			readonly cleanup: Generation["cleanup"]
		}
	>
	readonly target: string
	readonly execution: "NotStarted" | "Started"
	readonly executionPhase: Phase
	readonly executionOutcome: Outcome
	readonly compensation: "NotNeeded" | "Attempted" | "Completed" | "Failed"
	readonly current: Cell
	readonly healthy: boolean
	readonly matchesTarget: boolean
	readonly recoverable: boolean
	readonly reason: string
}
export interface Conclusion {
	readonly outcome: Outcome
	readonly phase: Phase
	readonly cause: Cause.Cause<string>
	readonly members: HashMap.HashMap<string, MemberFact>
}
export interface Change {
	readonly plan: Plan
	readonly phase: Phase
	readonly oldChanged: boolean
	readonly invalidated: boolean
	readonly created: HashSet.HashSet<string>
	readonly ownedVersions: HashMap.HashMap<ObjectKey, number>
	readonly view: Option.Option<View>
	readonly viewSequence: number
	readonly cause: Cause.Cause<string>
	readonly conclusion: Option.Option<Conclusion>
}
export interface Model {
	readonly open: boolean
	readonly cells: HashMap.HashMap<ObjectKey, Cell>
	readonly reservations: HashMap.HashMap<ObjectKey, Reservation>
	readonly changes: HashMap.HashMap<string, Change>
	readonly generations: HashMap.HashMap<string, Generation>
	readonly terms: HashMap.HashMap<string, number>
	readonly groups: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly leaseHolders: HashMap.HashMap<string, HashSet.HashSet<string>>
	readonly unavailable: HashSet.HashSet<ObjectKey>
	readonly stopping: HashSet.HashSet<string>
	// Count logical object probes in admission and commit, not HAMT internals.
	// The verifier and fixture planner deliberately do not contribute to this log.
	readonly accesses: HashMap.HashMap<ObjectKey, number>
}
export type Action = Data.TaggedEnum<{
	Submit: { readonly plan: Plan }
	Prepare: { readonly change: string }
	StopOld: { readonly change: string }
	Install: { readonly change: string }
	Acknowledge: { readonly token: Token }
	Commit: { readonly change: string }
	Cancel: { readonly change: string }
	Withdraw: { readonly change: string; readonly object: ObjectKey }
	Invalidate: { readonly object: ObjectKey; readonly cause: string }
	ReleaseLease: { readonly consumer: string; readonly provider: string }
	Evidence: {
		readonly generation: string
		readonly evidence: "Exited" | "NotStarted"
		readonly cleanup?: "Unknown" | "Completed"
		readonly cause?: Cause.Cause<string>
	}
	Retire: { readonly generation: string }
	Recover: { readonly change: string; readonly allowed: boolean }
	Finish: { readonly change: string }
	Deadline: { readonly change: string }
	Close: {}
}>
export const Action = Data.taggedEnum<Action>()
export type Decision =
	| "Applied"
	| "Busy"
	| "Stale"
	| "Closed"
	| "Blocked"
	| "RejectedAck"
	| "InvalidPhase"
	| "InvalidPlan"
export interface Step {
	readonly state: Model
	readonly decision: Decision
	readonly conflicts: HashSet.HashSet<ObjectKey>
}
const absent: Cell = { version: 0, value: Option.none() }
const unreserved: Reservation = {
	writer: Option.none(),
	readers: HashSet.empty(),
}
export const cell = (s: Model, key: ObjectKey): Cell =>
	Option.getOrElse(HashMap.get(s.cells, key), () => absent)
export const change = (s: Model, id: string): Change =>
	HashMap.getUnsafe(s.changes, id)
export const generation = (s: Model, id: string): Generation =>
	HashMap.getUnsafe(s.generations, id)
const touch = (s: Model, key: ObjectKey): Model => ({
	...s,
	accesses: HashMap.set(
		s.accesses,
		key,
		Option.getOrElse(HashMap.get(s.accesses, key), () => 0) + 1,
	),
})
const readCell = (s: Model, key: ObjectKey): readonly [Model, Cell] => [
	touch(s, key),
	cell(s, key),
]
const readReservation = (
	s: Model,
	key: ObjectKey,
): readonly [Model, Reservation] => [
	touch(s, key),
	Option.getOrElse(HashMap.get(s.reservations, key), () => unreserved),
]
const writeCell = (
	s: Model,
	key: ObjectKey,
	value: Option.Option<string>,
): Model => {
	const [next, previous] = readCell(s, key)
	return {
		...next,
		cells: HashMap.set(next.cells, key, {
			version: previous.version + 1,
			value,
		}),
	}
}
const save = (s: Model, c: Change): Model => ({
	...s,
	changes: HashMap.set(s.changes, c.plan.id, c),
})
const result = (
	state: Model,
	decision: Decision = "Applied",
	conflicts = HashSet.empty<ObjectKey>(),
): Step => ({ state, decision, conflicts })
const allKeys = (p: Plan) =>
	HashSet.union(p.writes, HashSet.fromIterable(HashMap.keys(p.reads)))
const owns = (r: Reservation, id: string) =>
	Option.contains(r.writer, id) || HashSet.has(r.readers, id)
const oldGenerations = (c: Change) =>
	HashSet.fromIterable(
		Arr.map(Arr.fromIterable(HashMap.values(c.plan.members)), (m) => m.old),
	)
const retired = (s: Model, ids: HashSet.HashSet<string>) =>
	HashSet.every(ids, (id) => generation(s, id).retired)
const cleanup = (c: Change): HashSet.HashSet<string> => {
	if (c.phase === "Switched") return oldGenerations(c)
	if (c.phase === "Cancelling") return c.created
	const active = Option.match(c.view, {
		onNone: () => HashSet.empty<string>(),
		onSome: (v) =>
			v.recovery && c.phase === "Restored"
				? HashSet.fromIterable(HashMap.values(v.generations))
				: HashSet.empty<string>(),
	})
	return HashSet.difference(HashSet.union(c.created, oldGenerations(c)), active)
}
const fail = (c: Change, reason: string): Change => ({
	...c,
	cause: Cause.combine(c.cause, Cause.fail(reason)),
})
const cancel = (s: Model, c: Change, reason: string): Model => {
	const next: Change = {
		...fail(c, reason),
		phase: c.oldChanged || c.invalidated ? "Recovering" : "Cancelling",
		view: Option.none(),
	}
	return save(
		{ ...s, stopping: HashSet.union(s.stopping, cleanup(next)) },
		next,
	)
}

const submit = (initial: Model, plan: Plan): Step => {
	if (!initial.open) return result(initial, "Closed")
	if (HashMap.has(initial.changes, plan.id))
		return result(initial, "InvalidPlan")
	const footprint = HashMap.reduce(
		plan.members,
		{
			state: initial,
			valid: HashMap.size(plan.members) > 0,
			publications: HashSet.empty<ObjectKey>(),
		},
		(acc, m) => {
			const grouped = touch(acc.state, ObjectKey.Group({ id: m.group }))
			const group = Option.getOrElse(HashMap.get(grouped.groups, m.group), () =>
				HashSet.empty<string>(),
			)
			const indexed = touch(grouped, ObjectKey.Generation({ id: m.old }))
			const holders = Option.getOrElse(
				HashMap.get(indexed.leaseHolders, m.old),
				() => HashSet.empty<string>(),
			)
			const consumers = HashSet.reduce(
				holders,
				{ state: indexed, valid: true },
				(checked, id) => ({
					state: touch(checked.state, ObjectKey.Generation({ id })),
					valid:
						checked.valid &&
						HashMap.has(plan.members, generation(checked.state, id).instance),
				}),
			)
			const unique = HashSet.every(
				m.publications,
				(key) => !HashSet.has(acc.publications, key),
			)
			return {
				state: consumers.state,
				publications: HashSet.union(acc.publications, m.publications),
				valid:
					acc.valid &&
					consumers.valid &&
					unique &&
					HashSet.every(group, (id) => HashMap.has(plan.members, id)) &&
					HashSet.has(plan.writes, ObjectKey.Instance({ id: m.instance })) &&
					HashSet.has(plan.writes, ObjectKey.Group({ id: m.group })) &&
					HashSet.every(m.publications, (key) =>
						HashSet.has(plan.writes, key),
					) &&
					HashMap.every(
						m.dependencies,
						(dep, key) =>
							HashMap.has(plan.reads, key) &&
							HashSet.has(
								plan.writes,
								ObjectKey.Edge({
									consumer: m.instance,
									provider: dep.provider,
								}),
							),
					),
			}
		},
	)
	const participants = HashSet.reduce(
		plan.participants,
		{ state: footprint.state, valid: footprint.valid },
		(acc, id) => {
			const next = touch(acc.state, ObjectKey.Generation({ id }))
			const gen = HashMap.get(next.generations, id)
			return {
				state: next,
				valid:
					acc.valid &&
					Option.isSome(gen) &&
					HashMap.has(
						plan.reads,
						ObjectKey.Instance({ id: gen.value.instance }),
					),
			}
		},
	)
	if (!participants.valid) return result(participants.state, "InvalidPlan")
	const inspected = HashSet.reduce(
		allKeys(plan),
		{
			state: participants.state,
			conflicts: HashSet.empty<ObjectKey>(),
			stale: false,
		},
		(acc, key) => {
			const [s1, lock] = readReservation(acc.state, key)
			const [s2, current] = readCell(s1, key)
			const expected = HashMap.get(plan.reads, key)
			const conflict =
				Option.isSome(lock.writer) ||
				(HashSet.has(plan.writes, key) && HashSet.size(lock.readers) > 0)
			return {
				state: s2,
				conflicts: conflict ? HashSet.add(acc.conflicts, key) : acc.conflicts,
				stale:
					acc.stale ||
					Option.isNone(expected) ||
					expected.value.version !== current.version,
			}
		},
	)
	if (HashSet.size(inspected.conflicts) > 0)
		return result(inspected.state, "Busy", inspected.conflicts)
	if (inspected.stale) return result(inspected.state, "Stale")
	const state = HashSet.reduce(allKeys(plan), inspected.state, (s, key) => {
		const [next, lock] = readReservation(s, key)
		return {
			...next,
			reservations: HashMap.set(
				next.reservations,
				key,
				HashSet.has(plan.writes, key)
					? { writer: Option.some(plan.id), readers: HashSet.empty() }
					: { ...lock, readers: HashSet.add(lock.readers, plan.id) },
			),
		}
	})
	return result(
		save(state, {
			plan,
			phase: "Admitted",
			oldChanged: false,
			invalidated: false,
			created: HashSet.empty(),
			ownedVersions: HashMap.map(plan.reads, (v) => v.version),
			view: Option.none(),
			viewSequence: 0,
			cause: Cause.empty,
			conclusion: Option.none(),
		}),
	)
}

// The transaction reads only the plan footprint. Read/read sharing is compatible.
const validate = (initial: Model, c: Change): readonly [Model, boolean] =>
	HashSet.reduce(
		allKeys(c.plan),
		[initial, true] satisfies readonly [Model, boolean],
		([s, valid], key): readonly [Model, boolean] => {
			const [s1, lock] = readReservation(s, key)
			const [s2, current] = readCell(s1, key)
			return [
				s2,
				valid &&
					owns(lock, c.plan.id) &&
					current.version === HashMap.getUnsafe(c.ownedVersions, key),
			]
		},
	)

const prepare = (initial: Model, c: Change, recovery: boolean): Step => {
	if (!recovery && c.phase !== "Admitted")
		return result(initial, "InvalidPhase")
	if (!recovery && c.invalidated) return result(initial, "Stale")
	const [checked, valid] = validate(initial, c)
	if (!valid && !recovery)
		return result(
			cancel(checked, { ...c, invalidated: true }, "Read premises changed"),
			"Stale",
		)
	// Recovery may re-resolve read-only dependencies, but never overwrite a lost write version.
	const writeCheck = HashSet.reduce(
		c.plan.writes,
		[checked, true] satisfies readonly [Model, boolean],
		([s, ok], key): readonly [Model, boolean] => {
			const [locked, lock] = readReservation(s, key)
			const [next, value] = readCell(locked, key)
			return [
				next,
				ok &&
					Option.contains(lock.writer, c.plan.id) &&
					value.version === HashMap.getUnsafe(c.ownedVersions, key),
			]
		},
	)
	if (recovery && !writeCheck[1])
		return result(
			save(
				writeCheck[0],
				fail({ ...c, phase: "Failed" }, "Recovery lost an owned version"),
			),
			"Stale",
		)
	const resolved = HashMap.reduce(
		c.plan.members,
		{
			state: writeCheck[0],
			resolutions: HashMap.empty<string, HashMap.HashMap<ObjectKey, string>>(),
			valid: true,
		},
		(acc, member) => {
			const dependencies = HashMap.reduce(
				member.dependencies,
				{
					state: acc.state,
					resolution: HashMap.empty<ObjectKey, string>(),
					valid: true,
				},
				(r, dep, key) => {
					const [next, value] = readCell(r.state, key)
					const available =
						Option.isSome(value.value) && !HashSet.has(next.unavailable, key)
					return {
						state: next,
						valid: r.valid && (available || dep.optional),
						resolution:
							available && Option.isSome(value.value)
								? HashMap.set(r.resolution, key, value.value.value)
								: r.resolution,
					}
				},
			)
			return {
				state: dependencies.state,
				valid: acc.valid && dependencies.valid,
				resolutions: HashMap.set(
					acc.resolutions,
					member.instance,
					dependencies.resolution,
				),
			}
		},
	)
	if (!resolved.valid) {
		const failed = fail(
			{ ...c, invalidated: true },
			"Required dependency is unavailable",
		)
		return result(
			recovery
				? save(resolved.state, { ...failed, phase: "Failed" })
				: cancel(resolved.state, failed, "Dependency resolution failed"),
			"Stale",
		)
	}
	const allocated = HashMap.reduce(
		c.plan.members,
		{
			state: resolved.state,
			ids: HashMap.empty<string, string>(),
			created: c.created,
		},
		(acc, member) => {
			const term =
				Option.getOrElse(
					HashMap.get(acc.state.terms, member.instance),
					() => 0,
				) + 1
			const id = `${member.instance}#${term}`
			const resolution = HashMap.getUnsafe(
				resolved.resolutions,
				member.instance,
			)
			const leases = HashSet.fromIterable(HashMap.values(resolution))
			const gen: Generation = {
				id,
				instance: member.instance,
				config: recovery
					? generation(acc.state, member.old).config
					: member.target,
				owner: c.plan.id,
				publications: member.publications,
				started: false,
				resolution,
				leases,
				evidence: "Missing",
				retired: false,
				cleanup: "Unknown",
				exitCause: Cause.empty,
			}
			return {
				state: {
					...acc.state,
					terms: HashMap.set(acc.state.terms, member.instance, term),
					generations: HashMap.set(acc.state.generations, id, gen),
					leaseHolders: HashSet.reduce(
						leases,
						acc.state.leaseHolders,
						(index, provider) =>
							HashMap.set(
								index,
								provider,
								HashSet.add(
									Option.getOrElse(HashMap.get(index, provider), () =>
										HashSet.empty(),
									),
									id,
								),
							),
					),
				},
				ids: HashMap.set(acc.ids, member.instance, id),
				created: HashSet.add(acc.created, id),
			}
		},
	)
	const staged = HashMap.reduce(allocated.ids, allocated.state, (state, id) => {
		const gen = generation(state, id)
		const resolution = HashMap.map(gen.resolution, (provider) =>
			Option.getOrElse(
				HashMap.get(allocated.ids, generation(state, provider).instance),
				() => provider,
			),
		)
		const leases = HashSet.fromIterable(HashMap.values(resolution))
		const removed = HashSet.reduce(
			gen.leases,
			state.leaseHolders,
			(index, provider) =>
				HashMap.set(
					index,
					provider,
					HashSet.remove(
						Option.getOrElse(HashMap.get(index, provider), () =>
							HashSet.empty(),
						),
						id,
					),
				),
		)
		const added = HashSet.reduce(leases, removed, (index, provider) =>
			HashMap.set(
				index,
				provider,
				HashSet.add(
					Option.getOrElse(HashMap.get(index, provider), () => HashSet.empty()),
					id,
				),
			),
		)
		return {
			...state,
			generations: HashMap.set(state.generations, id, {
				...gen,
				resolution,
				leases,
			}),
			leaseHolders: added,
		}
	})
	const patch = HashMap.reduce(
		c.plan.members,
		HashMap.empty<ObjectKey, Option.Option<string>>(),
		(p, member) => {
			const value = Option.some(
				HashMap.getUnsafe(allocated.ids, member.instance),
			)
			const withInstance = HashMap.set(
				p,
				ObjectKey.Instance({ id: member.instance }),
				value,
			)
			const published = HashSet.reduce(
				member.publications,
				withInstance,
				(map, key) => HashMap.set(map, key, value),
			)
			const gen = generation(
				staged,
				HashMap.getUnsafe(allocated.ids, member.instance),
			)
			return HashMap.reduce(member.dependencies, published, (map, dep, key) =>
				HashMap.set(
					map,
					ObjectKey.Edge({ consumer: member.instance, provider: dep.provider }),
					HashMap.get(gen.resolution, key),
				),
			)
		},
	)
	const premises = HashMap.reduce(
		c.plan.reads,
		c.ownedVersions,
		(versions, _, key) =>
			HashSet.has(c.plan.writes, key)
				? versions
				: HashMap.set(versions, key, cell(staged, key).version),
	)
	const view: View = {
		version: c.viewSequence + 1,
		generations: allocated.ids,
		patch,
		acknowledgements: HashSet.empty(),
		recovery,
		required: HashSet.union(
			c.plan.participants,
			HashSet.fromIterable(HashMap.values(allocated.ids)),
		),
	}
	return result(
		save(staged, {
			...c,
			phase: "Prepared",
			created: allocated.created,
			ownedVersions: premises,
			invalidated: false,
			view: Option.some(view),
			viewSequence: view.version,
		}),
	)
}

const commit = (initial: Model, c: Change): Step => {
	if (c.phase !== "Installed" || Option.isNone(c.view))
		return result(initial, "InvalidPhase")
	const view = c.view.value
	if (
		!HashSet.every(view.required, (id) =>
			HashSet.has(view.acknowledgements, id),
		)
	)
		return result(initial, "Blocked")
	const endpoints = HashSet.reduce(
		view.required,
		{ state: initial, valid: true },
		(acc, id) => {
			const next = touch(acc.state, ObjectKey.Generation({ id }))
			const gen = generation(next, id)
			return {
				state: next,
				valid: acc.valid && gen.evidence === "Missing" && !gen.retired,
			}
		},
	)
	const stopped =
		c.plan.strategy === "Restart"
			? HashSet.reduce(oldGenerations(c), endpoints, (acc, id) => ({
					state: touch(acc.state, ObjectKey.Generation({ id })),
					valid: acc.valid && generation(acc.state, id).retired,
				}))
			: endpoints
	if (!stopped.valid)
		return result(
			cancel(stopped.state, c, "A required endpoint is unavailable"),
			"Stale",
		)
	const [checked, valid] = validate(stopped.state, c)
	if (!valid || c.invalidated)
		return result(
			cancel(checked, { ...c, invalidated: true }, "Commit premises changed"),
			"Stale",
		)
	const applied = HashSet.reduce(
		c.plan.writes,
		{ state: checked, versions: c.ownedVersions },
		(acc, key) => {
			const [read, previous] = readCell(acc.state, key)
			const value = Option.getOrElse(
				HashMap.get(view.patch, key),
				() => previous.value,
			)
			const next = writeCell(read, key, value)
			return {
				state: next,
				versions: HashMap.set(acc.versions, key, previous.version + 1),
			}
		},
	)
	const next = applied.state
	return result(
		save(
			{
				...next,
				stopping: HashSet.union(next.stopping, oldGenerations(c)),
				unavailable: HashMap.reduce(
					view.patch,
					next.unavailable,
					(keys, _, key) => HashSet.remove(keys, key),
				),
			},
			{
				...c,
				oldChanged: true,
				ownedVersions: applied.versions,
				phase: view.recovery ? "Restored" : "Switched",
			},
		),
	)
}

const finish = (initial: Model, c: Change, outcome: Outcome): Step => {
	const members = HashMap.map(c.plan.members, (member): MemberFact => {
		const current = cell(initial, ObjectKey.Instance({ id: member.instance }))
		const currentGen = Option.flatMap(current.value, (id) =>
			HashMap.get(initial.generations, id),
		)
		const healthy =
			Option.isSome(currentGen) &&
			!currentGen.value.retired &&
			!HashSet.has(
				initial.unavailable,
				ObjectKey.Instance({ id: member.instance }),
			)
		return {
			start: HashMap.getUnsafe(
				c.plan.reads,
				ObjectKey.Instance({ id: member.instance }),
			),
			startHealthy: member.startHealthy,
			termination: HashSet.reduce(
				HashSet.add(c.created, member.old),
				HashMap.empty<
					string,
					{
						readonly evidence: Generation["evidence"]
						readonly cleanup: Generation["cleanup"]
					}
				>(),
				(map, id) => {
					const gen = generation(initial, id)
					return gen.instance === member.instance
						? HashMap.set(map, id, {
								evidence: gen.evidence,
								cleanup: gen.cleanup,
							})
						: map
				},
			),
			target: member.target,
			execution: HashSet.some(c.created, (id) => {
				const gen = generation(initial, id)
				return gen.instance === member.instance && gen.started
			})
				? "Started"
				: "NotStarted",
			executionPhase: c.phase,
			executionOutcome: outcome,
			compensation:
				outcome === "Recovered"
					? "Completed"
					: outcome === "RecoveryFailed"
						? "Failed"
						: c.phase === "Recovering"
							? "Attempted"
							: "NotNeeded",
			current,
			healthy,
			matchesTarget:
				healthy &&
				Option.isSome(currentGen) &&
				currentGen.value.config === member.target,
			recoverable: outcome !== "Stuck",
			reason:
				outcome === "Stuck"
					? "Exit evidence is missing"
					: "Recovery requires current dependencies and authorization",
		}
	})
	const settled: Change = {
		...c,
		phase: "Settled",
		conclusion: Option.some({
			outcome,
			phase: c.phase,
			cause: HashSet.reduce(
				HashSet.union(c.created, oldGenerations(c)),
				c.cause,
				(cause, id) => Cause.combine(cause, generation(initial, id).exitCause),
			),
			members,
		}),
	}
	const state =
		outcome === "Stuck"
			? initial
			: HashSet.reduce(allKeys(c.plan), initial, (s, key) => {
					const [next, lock] = readReservation(s, key)
					return {
						...next,
						reservations: HashMap.set(next.reservations, key, {
							writer: Option.contains(lock.writer, c.plan.id)
								? Option.none()
								: lock.writer,
							readers: HashSet.remove(lock.readers, c.plan.id),
						}),
					}
				})
	return result(save(state, settled))
}

const retire = (initial: Model, id: string): Step => {
	const gen = generation(initial, id)
	if (!HashSet.has(initial.stopping, id)) return result(initial, "InvalidPhase")
	if (
		gen.evidence === "Missing" ||
		HashSet.size(gen.leases) > 0 ||
		HashSet.size(
			Option.getOrElse(HashMap.get(initial.leaseHolders, id), () =>
				HashSet.empty(),
			),
		) > 0
	)
		return result(initial, "Blocked")
	// Publication ownership is a generation token. Late cleanup cannot remove a newer owner.
	const publications = gen.publications
	const next = HashSet.reduce(
		HashSet.add(publications, ObjectKey.Instance({ id: gen.instance })),
		initial,
		(s, key) => {
			const [checked, current] = readCell(s, key)
			// Retirement does not change desired state or object versions. The endpoint
			// tombstone is generation-owned; route availability is tracked separately.
			return Option.contains(current.value, id)
				? { ...checked, unavailable: HashSet.add(checked.unavailable, key) }
				: checked
		},
	)
	return result({
		...next,
		generations: HashMap.set(next.generations, id, { ...gen, retired: true }),
	})
}

export const step = (s: Model, action: Action): Step => {
	switch (action._tag) {
		case "Submit":
			return submit(s, action.plan)
		case "Close": {
			const closed = { ...s, open: false }
			return result(
				HashMap.reduce(s.changes, closed, (state, c) =>
					Option.isSome(c.conclusion)
						? state
						: cancel(state, c, "Runtime closed"),
				),
			)
		}
		case "Invalidate": {
			const [checked, lock] = readReservation(s, action.object)
			const withdrawn = {
				...writeCell(checked, action.object, Option.none()),
				unavailable: HashSet.add(checked.unavailable, action.object),
			}
			const affected = Option.match(lock.writer, {
				onNone: () => lock.readers,
				onSome: (id) => HashSet.add(lock.readers, id),
			})
			return result(
				HashSet.reduce(affected, withdrawn, (state, id) => {
					const c = change(state, id)
					return Option.isSome(c.conclusion)
						? state
						: cancel(state, { ...c, invalidated: true }, action.cause)
				}),
			)
		}
		case "ReleaseLease": {
			const consumer = generation(s, action.consumer)
			return result({
				...s,
				generations: HashMap.set(s.generations, consumer.id, {
					...consumer,
					leases: HashSet.remove(consumer.leases, action.provider),
				}),
				leaseHolders: HashMap.set(
					s.leaseHolders,
					action.provider,
					HashSet.remove(
						Option.getOrElse(HashMap.get(s.leaseHolders, action.provider), () =>
							HashSet.empty(),
						),
						consumer.id,
					),
				),
			})
		}
		case "Evidence": {
			const gen = generation(s, action.generation)
			if (
				!HashSet.has(s.stopping, gen.id) ||
				(action.evidence === "NotStarted" && gen.started)
			)
				return result(s, "InvalidPhase")
			// Protocol refinement: confirmed exit settles this generation's runtime
			// leases. It cannot certify finalizers or external resource cleanup.
			const leaseHolders = HashSet.reduce(
				gen.leases,
				s.leaseHolders,
				(index, provider) =>
					HashMap.set(
						index,
						provider,
						HashSet.remove(
							Option.getOrElse(HashMap.get(index, provider), () =>
								HashSet.empty(),
							),
							gen.id,
						),
					),
			)
			return result({
				...s,
				leaseHolders,
				generations: HashMap.set(s.generations, gen.id, {
					...gen,
					leases: HashSet.empty(),
					evidence: action.evidence,
					cleanup: action.cleanup ?? "Unknown",
					exitCause: Cause.combine(gen.exitCause, action.cause ?? Cause.empty),
				}),
			})
		}
		case "Retire":
			return retire(s, action.generation)
		case "Acknowledge": {
			const found = HashMap.get(s.changes, action.token.change)
			if (Option.isNone(found)) return result(s, "RejectedAck")
			const c = found.value
			if (
				c.phase !== "Installed" ||
				Option.isNone(c.view) ||
				c.view.value.version !== action.token.view ||
				!HashSet.has(c.view.value.required, action.token.generation) ||
				c.invalidated ||
				generation(s, action.token.generation).evidence !== "Missing"
			)
				return result(s, "RejectedAck")
			return result(
				save(s, {
					...c,
					view: Option.some({
						...c.view.value,
						acknowledgements: HashSet.add(
							c.view.value.acknowledgements,
							action.token.generation,
						),
					}),
				}),
			)
		}
		default: {
			const found = HashMap.get(s.changes, action.change)
			if (Option.isNone(found) || Option.isSome(found.value.conclusion))
				return result(s, "InvalidPhase")
			const c = found.value
			switch (action._tag) {
				case "Prepare":
					return prepare(s, c, false)
				case "Install": {
					if (c.phase !== "Prepared" || Option.isNone(c.view))
						return result(s, "InvalidPhase")
					if (c.plan.strategy === "Restart" && !retired(s, oldGenerations(c)))
						return result(s, "Blocked")
					const generations = HashMap.reduce(
						c.view.value.generations,
						s.generations,
						(map, id) =>
							HashMap.set(map, id, { ...generation(s, id), started: true }),
					)
					return result(
						save({ ...s, generations }, { ...c, phase: "Installed" }),
					)
				}
				case "Commit":
					return commit(s, c)
				case "Cancel":
					return result(cancel(s, c, "Change cancelled"))
				case "StopOld":
					return c.phase === "Prepared" && c.plan.strategy === "Restart"
						? result(
								save(
									{
										...s,
										stopping: HashSet.union(s.stopping, oldGenerations(c)),
									},
									{ ...c, oldChanged: true },
								),
							)
						: result(s, "InvalidPhase")
				case "Withdraw": {
					if (!HashSet.has(c.plan.writes, action.object))
						return result(s, "InvalidPlan")
					return result(
						save(
							{ ...s, unavailable: HashSet.add(s.unavailable, action.object) },
							{ ...c, oldChanged: true },
						),
					)
				}
				case "Recover": {
					if (c.phase !== "Recovering") return result(s, "InvalidPhase")
					if (!retired(s, cleanup(c))) return result(s, "Blocked")
					return action.allowed
						? prepare(s, c, true)
						: result(
								save(
									s,
									fail(
										{ ...c, phase: "Failed" },
										"Recovery authorization was revoked",
									),
								),
							)
				}
				case "Finish": {
					if (!retired(s, cleanup(c))) return result(s, "Blocked")
					switch (c.phase) {
						case "Switched":
							return finish(s, c, "Accepted")
						case "Cancelling":
							return finish(s, c, "Aborted")
						case "Restored":
							return finish(s, c, "Recovered")
						case "Failed":
							return finish(s, c, "RecoveryFailed")
						default:
							return result(s, "InvalidPhase")
					}
				}
				case "Deadline":
					return deadline(s, c)
			}
		}
	}
}

const deadline = (initial: Model, current: Change): Step => {
	const begun =
		current.phase === "Admitted" ||
		current.phase === "Prepared" ||
		current.phase === "Installed"
			? cancel(initial, current, "Change budget expired")
			: initial
	const c = change(begun, current.plan.id)
	const requested = {
		...begun,
		stopping: HashSet.union(begun.stopping, cleanup(c)),
	}
	const known = HashSet.reduce(cleanup(c), requested, (s, id) => {
		const gen = generation(s, id)
		return !gen.started && gen.evidence === "Missing"
			? step(
					s,
					Action.Evidence({
						generation: id,
						evidence: "NotStarted",
						cleanup: "Completed",
					}),
				).state
			: s
	})
	if (
		HashSet.some(
			cleanup(c),
			(id) => generation(known, id).evidence === "Missing",
		)
	)
		return finish(
			known,
			fail(c, "Termination evidence deadline expired"),
			"Stuck",
		)
	const cleaned = HashSet.reduce(
		cleanup(c),
		known,
		(s, id) => retire(s, id).state,
	)
	if (!retired(cleaned, cleanup(c))) return result(cleaned, "Blocked")
	switch (c.phase) {
		case "Switched":
			return finish(cleaned, c, "Accepted")
		case "Restored":
			return finish(cleaned, c, "Recovered")
		case "Cancelling":
			return finish(cleaned, c, "Aborted")
		default:
			return finish(
				cleaned,
				fail(c, "Recovery budget expired"),
				"RecoveryFailed",
			)
	}
}
