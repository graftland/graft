import {
	Array as Arr,
	Cause,
	Equal,
	HashMap,
	HashSet,
	Number as Num,
	Option,
} from "effect"

import * as InputSnapshot from "./decisionInput"
import type {
	Budget,
	Cell,
	Change,
	Claim,
	Command,
	CommandKind,
	Conclusion,
	Event,
	Input,
	Instance,
	MemberFact,
	Outcome,
	Phase,
	Rejection,
	Request,
	RequestIdentity,
	ResolvedInput,
	Settlement,
	State,
	Status,
	Target,
	Timer,
	TimerPurpose,
	Transition,
	Unit,
	Working,
} from "./decisionState.ts"
import * as Preparation from "./preparationCore"

export const getPreparation = Preparation.get
export type * from "./decisionState.ts"

const instanceOwner = (id: string): string => `instance:${id}`
const emptyCell: Cell = {
	version: 0,
	value: Option.none(),
	writer: Option.none(),
	readers: HashSet.empty(),
}
export const cell = (s: State, key: string): Cell =>
	Option.getOrElse(HashMap.get(s.cells, key), () => emptyCell)
const save = (s: Working, c: Change): Working => ({
	...s,
	changes: HashMap.set(s.changes, c.id, c),
	changed: HashSet.add(s.changed, c.id),
})
const withChange = (
	s: Working,
	id: string,
	f: (s: Working, c: Change) => Working,
): Working =>
	Option.match(HashMap.get(s.changes, id), {
		onNone: () => s,
		onSome: (c) => f(s, c),
	})
const withUnit = (
	s: Working,
	id: string,
	f: (s: Working, u: Unit) => Working,
): Working =>
	Option.match(HashMap.get(s.units, id), {
		onNone: () => s,
		onSome: (u) => f(s, u),
	})
const live = (s: State, id: string): boolean =>
	Option.exists(HashMap.get(s.units, id), (u) => u.evidence === "Missing")
const keys = (r: Request): HashSet.HashSet<string> =>
	HashSet.union(r.writes, HashSet.fromIterable(HashMap.keys(r.reads)))
const touch = (s: Working, key: string): Working => ({
	...s,
	accesses: HashMap.set(
		s.accesses,
		key,
		Option.getOrElse(HashMap.get(s.accesses, key), () => 0) + 1,
	),
})
const expired = (c: Change, s: State): boolean =>
	s.now >= c.deadline - c.request.budget.terminate

export const capacity = (
	s: State,
): { readonly used: number; readonly reserved: number } => {
	const used = HashMap.reduce(
		s.claims,
		0,
		(n, claim) => n + (Option.isSome(claim.unit) ? 1 : 0),
	)
	return { used, reserved: HashMap.size(s.claims) - used }
}
export const classify = (s: State, c: Change): Settlement => {
	if (HashSet.some(c.requiredExits, (id) => live(s, id))) return "Unresolved"
	if (
		HashSet.some(c.requiredExits, (id) =>
			Option.exists(
				HashMap.get(s.units, id),
				(u) => u.cleanup._tag === "Failed",
			),
		)
	)
		return "Failed"
	return HashSet.some(c.requiredExits, (id) =>
		Option.exists(
			HashMap.get(s.units, id),
			(u) => u.cleanup._tag === "Unknown",
		),
	)
		? "UnknownCleanup"
		: "Satisfied"
}

const member = (s: State, c: Change): MemberFact => {
	const instance = HashMap.get(s.instances, c.request.instance)
	const current = Option.flatMap(instance, (i) =>
		Option.flatMap(i.current, (id) => HashMap.get(s.units, id)),
	)
	const healthy =
		Option.exists(instance, (i) => i.healthy && i.authorized) &&
		Option.exists(
			current,
			(u) => u.evidence === "Missing" && u.phase === "Running",
		)
	return {
		instance: c.request.instance,
		reason: "ExplicitTarget",
		starting: c.previous,
		startingVersion: c.startingVersion,
		desired: c.request.target,
		actual: Option.map(current, (u) => u.target),
		healthy,
		matchesTarget:
			healthy &&
			Option.exists(current, (u) => Equal.equals(u.target, c.request.target)),
	}
}
export const get = (s: State, id: string): Option.Option<Status> =>
	Option.map(HashMap.get(s.changes, id), (c) => ({
		id,
		sequence: c.sequence,
		phase: c.phase,
		oldChanged: c.oldChanged,
		recovering: c.recovering,
		member: member(s, c),
		remaining: Num.max(0, c.deadline - s.now),
		leaseHolders: HashSet.filter(c.units, (id) =>
			Option.exists(
				HashMap.get(s.units, id),
				(u) => u.owner === c.id && HashSet.size(u.leases) > 0,
			),
		),
		unconfirmedUnits: HashSet.filter(c.requiredExits, (id) => live(s, id)),
		settlement: classify(s, c),
		cause: c.cause,
		conclusion: c.conclusion,
	}))

export const make = (options: {
	readonly authority: string
	readonly maxUnits: number
	readonly instances: ReadonlyArray<{
		readonly id: string
		readonly target: Target
	}>
}): State =>
	Arr.reduce(
		options.instances,
		{
			authority: options.authority,
			open: true,
			now: 0,
			nextChange: 1,
			nextPreparation: 1,
			preparationHistory: [],
			verifiedHistory: [],
			preparations: HashMap.empty(),
			preparationKeys: HashMap.empty(),
			verified: HashMap.empty(),
			policies: HashMap.empty(),
			historyLimit: 128,
			history: [],
			maxUnits: options.maxUnits,
			instances: HashMap.empty<string, Instance>(),
			cells: HashMap.empty<string, Cell>(),
			units: HashMap.empty<string, Unit>(),
			claims: HashMap.empty<string, Claim>(),
			changes: HashMap.empty<string, Change>(),
			active: HashSet.empty<string>(),
			observers: HashMap.empty<string, HashSet.HashSet<string>>(),
			commands: HashMap.empty<string, Command>(),
			timers: HashMap.empty(),
			keys: HashMap.empty(),
			accesses: HashMap.empty(),
		} satisfies State,
		(s: State, entry): State => {
			const id = `${entry.id}@0`
			const unit: Unit = {
				kind: "Execution",
				id,
				incarnation: `${options.authority}/${id}`,
				instance: entry.id,
				term: 0,
				target: InputSnapshot.target(entry.target),
				owner: instanceOwner(entry.id),
				claim: id,
				spawn: `${id}/initial`,
				phase: "Running",
				evidence: "Missing",
				cleanup: { _tag: "Unknown" },
				cause: Cause.empty,
				leases: HashSet.empty(),
			}
			return {
				...s,
				instances: HashMap.set(s.instances, entry.id, {
					id: entry.id,
					desired: InputSnapshot.target(entry.target),
					current: Option.some(id),
					term: 0,
					healthy: true,
					authorized: true,
				}),
				cells: HashMap.set(s.cells, entry.id, {
					...emptyCell,
					version: 1,
					value: Option.some(id),
				}),
				units: HashMap.set(s.units, id, unit),
				claims: HashMap.set(s.claims, id, {
					id,
					owner: instanceOwner(entry.id),
					unit: Option.some(id),
				}),
			}
		},
	)

const emit = (
	s: Working,
	c: Change,
	kind: CommandKind,
	unit = "",
	participant = "",
	timer: Option.Option<string> = Option.none(),
): Working => {
	const u = HashMap.get(s.units, unit)
	const command: Command = {
		dispatched: true,
		id: `${c.id}/${c.nextCommand}`,
		change: c.id,
		kind,
		unit,
		participant,
		timer,
		target: c.recovering ? c.previous : c.request.target,
		policy: Preparation.policy(s, c.request.instance),
		...(Option.isSome(c.resolved) ? { resolution: c.resolved.value } : {}),
		...(Option.isSome(c.description)
			? { description: c.description.value }
			: {}),
		probes: c.request.probes ?? [],
		token: {
			authority: s.authority,
			change: c.id,
			unit,
			incarnation: Option.match(u, {
				onNone: () => "",
				onSome: (u) => u.incarnation,
			}),
			term: Option.match(u, { onNone: () => 0, onSome: (u) => u.term }),
			view: c.view,
		},
		status: kind === "Publish" ? get(s, c.id) : Option.none(),
		disposition: "Pending",
		report: Option.none(),
	}
	return {
		...save(s, {
			...c,
			nextCommand: c.nextCommand + 1,
			commandIds: HashSet.add(c.commandIds, command.id),
		}),
		commands: HashMap.set(s.commands, command.id, command),
		emitted: Arr.append(s.emitted, command),
	}
}
const issue = (
	s: Working,
	id: string,
	kind: CommandKind,
	unit = "",
	participant = "",
	timer: Option.Option<string> = Option.none(),
): Working =>
	withChange(s, id, (s, c) => emit(s, c, kind, unit, participant, timer))
const disarm = (
	s: Working,
	c: Change,
	purposes: HashSet.HashSet<string>,
): Working => ({
	...s,
	timers: HashSet.reduce(c.timerIds, s.timers, (timers, id) =>
		HashMap.modify(timers, id, (t) =>
			HashSet.has(purposes, t.purpose) ? { ...t, active: false } : t,
		),
	),
})
const obsolete = (s: Working, c: Change): Working => ({
	...s,
	commands: HashSet.reduce(c.commandIds, s.commands, (commands, id) =>
		HashMap.modify(commands, id, (cmd) =>
			cmd.disposition === "Pending" &&
			cmd.kind !== "Spawn" &&
			cmd.kind !== "Terminate"
				? { ...cmd, disposition: "Obsolete" }
				: cmd,
		),
	),
})
const arm = (
	s: Working,
	id: string,
	purpose: TimerPurpose,
	deadline: number,
	command: Option.Option<string> = Option.none(),
): Working =>
	withChange(s, id, (s, c) => {
		const timerId = `${c.id}/timer/${c.nextCommand}`
		const next = {
			...s,
			timers: HashMap.set(s.timers, timerId, {
				id: timerId,
				change: c.id,
				purpose,
				cause: Cause.empty,
				deadline,
				generation: c.nextCommand,
				active: true,
				command,
			}),
		}
		return emit(
			next,
			{ ...c, timerIds: HashSet.add(c.timerIds, timerId) },
			"ArmTimer",
			"",
			"",
			Option.some(timerId),
		)
	})
const phase = (s: Working, c: Change, p: Phase): Working =>
	save(s, { ...c, phase: p })
const operation = (
	s: Working,
	c: Change,
	kind: CommandKind,
	p: Phase,
	unit: string,
	limit: number,
): Working => {
	const cleared = disarm(phase(s, c, p), c, HashSet.make("Operation"))
	const issued = issue(cleared, c.id, kind, unit)
	const command = Arr.last(issued.emitted)
	return arm(
		issued,
		c.id,
		"Operation",
		Num.min(s.now + limit, c.deadline - c.request.budget.terminate),
		Option.map(command, (c) => c.id),
	)
}
const owned = (s: State, c: Change): boolean =>
	HashMap.every(c.premises, (version, key) => {
		const current = cell(s, key)
		return (
			current.version === version &&
			(HashSet.has(c.request.writes, key)
				? Option.contains(current.writer, c.id)
				: HashSet.has(current.readers, c.id))
		)
	})
const availableOld = (s: State, c: Change): boolean =>
	!c.oldChanged &&
	c.authorized &&
	Option.exists(c.old, (id) => live(s, id)) &&
	Option.exists(
		HashMap.get(s.instances, c.request.instance),
		(i) => i.healthy && i.authorized,
	)
const settled = (s: State, ids: HashSet.HashSet<string>): boolean =>
	!HashSet.some(ids, (id) => live(s, id))
const evict = (s: Working, id: string): Working =>
	withChange(s, id, (s, c) => ({
		...s,
		changes: HashMap.remove(s.changes, id),
		commands: HashSet.reduce(c.commandIds, s.commands, (commands, id) =>
			HashMap.remove(commands, id),
		),
		timers: HashSet.reduce(c.timerIds, s.timers, (timers, id) =>
			HashMap.remove(timers, id),
		),
		units: HashSet.reduce(c.units, s.units, (units, unit) =>
			Option.exists(
				HashMap.get(units, unit),
				(u) =>
					u.evidence !== "Missing" &&
					(u.owner === id ||
						(u.owner === instanceOwner(u.instance) &&
							!Option.exists(HashMap.get(s.instances, u.instance), (i) =>
								Option.contains(i.current, u.id),
							))),
			)
				? HashMap.remove(units, unit)
				: units,
		),
		observers: HashMap.modify(s.observers, c.request.instance, (ids) =>
			HashSet.remove(ids, id),
		),
		changed: HashSet.remove(s.changed, id),
	}))
const archive = (s: Working, c: Change): Working => {
	if (c.request.key !== undefined) return s
	const history = Arr.append(s.history, c.id)
	if (history.length <= Num.max(1, s.historyLimit)) return { ...s, history }
	return Option.match(Arr.head(history), {
		onNone: () => s,
		onSome: (id) => evict({ ...s, history: Arr.drop(history, 1) }, id),
	})
}
const release = (s: Working, c: Change): Working => {
	if (c.released || !settled(s, c.requiredExits)) return s
	const released = HashSet.reduce(keys(c.request), s, (s, key) => {
		const current = cell(s, key)
		return {
			...s,
			cells: HashMap.set(s.cells, key, {
				...current,
				writer: Option.contains(current.writer, c.id)
					? Option.none()
					: current.writer,
				readers: HashSet.remove(current.readers, c.id),
			}),
		}
	})
	const transferred = c.transferred
	const claims = HashSet.reduce(c.claims, released.claims, (claims, id) =>
		Option.match(HashMap.get(claims, id), {
			onNone: () => claims,
			onSome: (claim) =>
				claim.owner !== c.id
					? claims
					: Option.isSome(claim.unit) &&
						  Option.contains(transferred, claim.unit.value)
						? HashMap.set(claims, id, {
								...claim,
								owner: instanceOwner(c.request.instance),
							})
						: Option.isNone(claim.unit)
							? HashMap.remove(claims, id)
							: claims,
		}),
	)
	const units = HashSet.reduce(c.units, released.units, (units, id) =>
		HashMap.modify(units, id, (u) =>
			Option.contains(transferred, id)
				? { ...u, owner: instanceOwner(c.request.instance) }
				: u,
		),
	)
	return archive(
		save(
			{
				...released,
				claims,
				units,
				active: HashSet.remove(released.active, c.id),
			},
			{ ...c, released: true, transferred },
		),
		c,
	)
}
const transferServing = (s: Working, c: Change): Working =>
	Option.match(c.transferred, {
		onNone: () => s,
		onSome: (id) =>
			withUnit(s, id, (s, u) =>
				u.owner !== c.id
					? s
					: {
							...s,
							units: HashMap.set(s.units, id, {
								...u,
								owner: instanceOwner(c.request.instance),
							}),
							claims: HashMap.modify(s.claims, u.claim, (claim) =>
								claim.owner === c.id
									? { ...claim, owner: instanceOwner(c.request.instance) }
									: claim,
							),
						},
			),
	})
const conclude = (s: Working, c: Change, outcome: Outcome): Working => {
	if (Option.isSome(c.conclusion)) return release(s, c)
	const classification = classify(s, c)
	if (classification === "Unresolved" && outcome !== "Stuck") return s
	if (classification === "Failed" && outcome === "Accepted")
		return fail(s, c, Cause.fail("Required retirement cleanup failed"))
	const conclusion: Conclusion = {
		outcome,
		phase: Option.getOrElse(c.interrupted, () => c.phase),
		cause: c.cause,
		member: member(s, c),
		units: c.units,
	}
	const next: Change = {
		...c,
		phase: "Concluded",
		conclusion: Option.some(conclusion),
		transferred:
			outcome === "Accepted" ||
			outcome === "Recovered" ||
			(!c.failure && c.trialPassed)
				? c.candidate
				: availableOld(s, c)
					? c.old
					: Option.none(),
	}
	const saved = save(
		obsolete(
			disarm(s, c, HashSet.make("Operation", "Trial", "Total", "Evidence")),
			c,
		),
		next,
	)
	return release(transferServing(saved, next), next)
}
const terminate = (
	s: Working,
	c: Change,
	units: HashSet.HashSet<string>,
): Working =>
	HashSet.reduce(units, s, (s, id) =>
		withUnit(s, id, (s, u) => {
			if (u.evidence !== "Missing" || u.phase === "Terminating") return s
			return issue(
				{
					...s,
					units: HashMap.set(s.units, id, { ...u, phase: "Terminating" }),
				},
				c.id,
				"Terminate",
				id,
			)
		}),
	)
const resolve = (s: Working, c: Change): Working =>
	operation(s, c, "Resolve", "Resolving", "", c.request.budget.startup)
const progressSettlement = (s: Working, c: Change): Working => {
	if (Option.isSome(c.conclusion)) return release(s, c)
	if (!settled(s, c.requiredExits)) return s
	if (!c.failure) {
		if (c.phase === "Retiring" && c.trialPassed)
			return conclude(s, c, c.recovering ? "Recovered" : "Accepted")
		if (c.phase === "Retiring") return resolve(s, c)
		return s
	}
	if (c.shuttingDown) return conclude(s, c, "RecoveryFailed")
	if (availableOld(s, c)) return conclude(s, c, "Aborted")
	if (
		c.recovering ||
		c.recoveryFailed ||
		expired(c, s) ||
		!HashSet.every(
			c.request.writes,
			(key) =>
				Option.contains(cell(s, key).writer, c.id) &&
				Option.contains(HashMap.get(c.premises, key), cell(s, key).version),
		)
	)
		return conclude(s, c, "RecoveryFailed")
	const recovering: Change = {
		...c,
		recovering: true,
		failure: false,
		premises: HashMap.map(c.premises, (v, key) =>
			HashSet.has(c.request.writes, key) ? v : cell(s, key).version,
		),
		authorized: true,
		candidate: Option.none(),
		installed: HashSet.empty(),
		requiredParticipants: HashSet.empty(),
		trialPassed: false,
		view: c.view + 1,
	}
	return resolve(
		save(
			disarm(s, c, HashSet.make("Operation", "Evidence", "Trial")),
			recovering,
		),
		recovering,
	)
}
const fail = (s: Working, c: Change, cause: Cause.Cause<unknown>): Working => {
	if (Option.isSome(c.conclusion)) return s
	const required = HashSet.union(
		c.requiredExits,
		c.shuttingDown || c.oldChanged || !availableOld(s, c)
			? c.units
			: Option.match(c.candidate, {
					onNone: () => HashSet.empty<string>(),
					onSome: (id) => HashSet.make(id),
				}),
	)
	const failed: Change = {
		...c,
		phase: "Settling",
		interrupted: Option.orElse(c.interrupted, () => Option.some(c.phase)),
		failure: true,
		requiredExits: required,
		oldChanged:
			c.oldChanged || Option.exists(c.old, (id) => HashSet.has(required, id)),
		cause: Cause.combine(c.cause, cause),
		recoveryFailed: c.recoveryFailed || c.recovering,
	}
	const stopped = terminate(
		save(
			c.failure
				? s
				: disarm(s, c, HashSet.make("Operation", "Trial", "Evidence")),
			failed,
		),
		failed,
		required,
	)
	const wasFailing = c.failure
	return withChange(stopped, c.id, (s, c) =>
		settled(s, required)
			? progressSettlement(s, c)
			: wasFailing
				? s
				: arm(
						s,
						c.id,
						"Evidence",
						Num.min(s.now + c.request.budget.terminate, c.deadline),
					),
	)
}
const stopOld = (s: Working, c: Change): Working => {
	const stopping: Change = {
		...c,
		oldChanged: true,
		phase: "Retiring",
		requiredExits: HashSet.union(
			c.requiredExits,
			Option.match(c.old, {
				onNone: () => HashSet.empty<string>(),
				onSome: (id) => HashSet.make(id),
			}),
		),
	}
	const unavailable =
		c.request.strategy === "Restart" || c.recovering
			? {
					...s,
					instances: HashMap.modify(s.instances, c.request.instance, (i) => ({
						...i,
						healthy: false,
					})),
				}
			: s
	const saved = save(unavailable, stopping)
	return Option.match(c.old, {
		onNone: () => progressSettlement(saved, stopping),
		onSome: (id) =>
			live(s, id)
				? operation(
						saved,
						stopping,
						"Stop",
						"Retiring",
						id,
						c.request.budget.stop,
					)
				: progressSettlement(saved, stopping),
	})
}
const spawn = (s: Working, c: Change): Working => {
	const free = Arr.findFirst(c.claims, (id) =>
		Option.exists(
			HashMap.get(s.claims, id),
			(claim) => claim.owner === c.id && Option.isNone(claim.unit),
		),
	)
	const instance = HashMap.get(s.instances, c.request.instance)
	if (Option.isNone(free) || Option.isNone(instance))
		return fail(s, c, Cause.fail("Reserved execution capacity is unavailable"))
	const term = instance.value.term + 1
	const id = `${c.request.instance}@${term}`
	const unit: Unit = {
		kind: "Execution",
		id,
		incarnation: `${s.authority}/${id}`,
		instance: c.request.instance,
		term,
		target: c.recovering ? c.previous : c.request.target,
		owner: c.id,
		claim: free.value,
		spawn: `${c.id}/${c.nextCommand}`,
		phase: "PendingSpawn",
		evidence: "Missing",
		cleanup: { _tag: "Unknown" },
		cause: Cause.empty,
		leases: c.request.leases,
	}
	const next = save(
		{
			...s,
			instances: HashMap.set(s.instances, instance.value.id, {
				...instance.value,
				term,
			}),
			units: HashMap.set(s.units, id, unit),
			claims: HashMap.modify(s.claims, free.value, (claim) => ({
				...claim,
				unit: Option.some(id),
			})),
		},
		{ ...c, candidate: Option.some(id), units: HashSet.add(c.units, id) },
	)
	return withChange(next, c.id, (s, c) =>
		operation(s, c, "Spawn", "Spawning", id, c.request.budget.startup),
	)
}
const install = (s: Working, c: Change, unit: string): Working => {
	const required = HashSet.add(c.request.participants, unit)
	const staged: Change = {
		...c,
		phase: "Installing" satisfies Phase,
		requiredParticipants: required,
		installed: HashSet.empty<string>(),
	}
	const saved = save(disarm(s, c, HashSet.make("Operation")), staged)
	const installed = HashSet.reduce(required, saved, (s, participant) =>
		issue(s, c.id, "Install", unit, participant),
	)
	return arm(
		installed,
		c.id,
		"Operation",
		Num.min(
			s.now + c.request.budget.startup,
			c.deadline - c.request.budget.terminate,
		),
	)
}
const forgetEndedCurrent = (s: Working, instance: string): Working =>
	Option.match(
		Option.flatMap(HashMap.get(s.instances, instance), (i) =>
			Option.flatMap(i.current, (id) => HashMap.get(s.units, id)),
		),
		{
			onNone: () => s,
			onSome: (u) =>
				u.evidence !== "Missing" &&
				u.owner === instanceOwner(instance) &&
				!HashMap.has(s.commands, u.spawn)
					? { ...s, units: HashMap.remove(s.units, u.id) }
					: s,
		},
	)
const commit = (s: Working, c: Change): Working => {
	if (!owned(s, c))
		return fail(s, c, Cause.fail("Commit lost a version or reservation"))
	if (Option.isNone(c.candidate) || !live(s, c.candidate.value))
		return fail(s, c, Cause.fail("Candidate is unavailable"))
	const candidate = c.candidate.value
	const applied = HashSet.reduce(
		c.request.writes,
		forgetEndedCurrent(s, c.request.instance),
		(s, key) => {
			const current = cell(s, key)
			return {
				...touch(s, key),
				cells: HashMap.set(s.cells, key, {
					...current,
					version: current.version + 1,
					value: Option.some(candidate),
				}),
			}
		},
	)
	const committed: Change = {
		...c,
		oldChanged: true,
		phase: "Trial",
		premises: HashMap.map(c.premises, (v, key) =>
			HashSet.has(c.request.writes, key) ? v + 1 : v,
		),
	}
	const next = save(
		{
			...applied,
			instances: HashMap.modify(applied.instances, c.request.instance, (i) => ({
				...i,
				desired: c.request.target,
				current: Option.some(candidate),
				healthy: true,
			})),
		},
		committed,
	)
	return arm(
		issue(
			disarm(next, c, HashSet.make("Operation")),
			c.id,
			"Activate",
			candidate,
		),
		c.id,
		"Trial",
		s.now + c.request.trial,
	)
}

export const defaultBudget: Budget = {
	total: 300000,
	startup: 30000,
	probe: 5000,
	drain: 5000,
	stop: 5000,
	terminate: 5000,
}
const requested = (s: Working, input: Input, inspect = false): Working => {
	const budget: Budget = { ...defaultBudget, ...input.budget }
	const target = InputSnapshot.target(input.target)
	const identity = {
		instance: input.instance,
		target,
		strategy: input.strategy ?? "Auto",
		expected: Option.fromNullishOr(input.expected),
		budget,
		probes: Arr.copy(input.requirements?.probes ?? []),
		trial: input.requirements?.trial ?? 0,
	} satisfies RequestIdentity
	const request: Request = {
		instance: input.instance,
		target,
		identity,
		strategy:
			input.strategy ??
			(target.overlap && target.placement !== "Runner" ? "Overlap" : "Restart"),
		reads: HashMap.make([
			input.instance,
			input.expected ?? cell(s, input.instance).version,
		]),
		writes: HashSet.make(input.instance),
		leases: HashSet.empty(),
		participants: HashSet.empty(),
		budget,
		probes: identity.probes,
		trial: identity.trial,
		...(input.key === undefined ? {} : { key: input.key }),
	}

	if (input.key !== undefined && HashMap.has(s.keys, input.key))
		return submit(s, request)
	if (input.key !== undefined && HashMap.has(s.preparationKeys, input.key))
		return Preparation.start(s, request, inspect)
	if (!s.open) return reject(s, "Closing")
	if (!HashMap.has(s.instances, input.instance))
		return reject(s, "UnsupportedTarget")
	if (!validBudget(request.budget, request.trial))
		return reject(s, "InvalidBudget")
	if (
		input.expected !== undefined &&
		input.expected !== cell(s, input.instance).version
	)
		return reject(s, "Stale", HashSet.make(input.instance))
	if (input.target.placement === "Runner" && input.strategy === "Overlap")
		return reject(s, "Unsupported")
	if (input.target.deployment === undefined)
		return reject(s, "UnsupportedTarget")
	if (!Preparation.authorized(s, input.instance, input.target))
		return reject(s, "Unauthorized")
	const known = Preparation.cached(s, input.target)
	if (
		!inspect &&
		Option.isSome(known) &&
		Equal.equals(
			known.value.policyValues ?? {},
			Preparation.policy(s, input.instance).values,
		)
	)
		return submit(s, {
			...request,
			submitted: s.now,
			policyVersion: Preparation.policy(s, input.instance).version,
			description: known.value.description,
			resolution: known.value.resolution,
			target: { ...request.target, overlap: known.value.description.overlap },
			strategy:
				input.strategy ??
				(known.value.description.overlap && input.target.placement !== "Runner"
					? "Overlap"
					: "Restart"),
		})
	return Preparation.start(s, request, inspect)
}
export const empty = (options: {
	readonly authority: string
	readonly maxUnits: number
	readonly instances: ReadonlyArray<{
		readonly id: string
		readonly target: Target
	}>
}): State => {
	const base = make({ ...options, instances: [] })
	return Arr.reduce(options.instances, base, (s, entry) => ({
		...s,
		instances: HashMap.set(s.instances, entry.id, {
			id: entry.id,
			desired: InputSnapshot.target(entry.target),
			current: Option.none(),
			term: 0,
			healthy: false,
			authorized: true,
		}),
		cells: HashMap.set(s.cells, entry.id, emptyCell),
	}))
}
const reject = (
	s: Working,
	reason: Rejection,
	conflicts = HashSet.empty<string>(),
): Working => ({ ...s, reply: { _tag: "Rejected", reason, conflicts } })
const validBudget = (budget: Budget, trial: number): boolean =>
	Arr.every(
		[
			budget.total,
			budget.startup,
			budget.probe,
			budget.drain,
			budget.stop,
			budget.terminate,
			trial,
		],
		(n) => Number.isFinite(n) && n >= 0,
	) &&
	budget.total >=
		2 * trial +
			2 *
				(budget.startup +
					budget.probe +
					budget.drain +
					budget.stop +
					budget.terminate) &&
	budget.total > 0
const submit = (s: Working, r: Request): Working => {
	const prior = r.key === undefined ? Option.none() : HashMap.get(s.keys, r.key)
	if (Option.isSome(prior))
		return Equal.equals(
			prior.value.request.identity ?? prior.value.request,
			r.identity ?? r,
		)
			? { ...s, reply: { _tag: "Admitted", change: prior.value.change } }
			: reject(s, "KeyConflict")
	if (!s.open) return reject(s, "Closing")
	const instance = HashMap.get(s.instances, r.instance)
	if (Option.isNone(instance)) return reject(s, "UnsupportedTarget")
	if (
		(r.members !== undefined &&
			(HashSet.size(r.members) !== 1 || !HashSet.has(r.members, r.instance))) ||
		(r.localDependencies !== undefined &&
			HashSet.size(r.localDependencies) > 0) ||
		!HashSet.has(r.writes, r.instance) ||
		(r.strategy === "Overlap" &&
			(!r.target.overlap || r.target.placement === "Runner"))
	)
		return reject(s, "Unsupported")
	if (
		!validBudget(
			{
				...r.budget,
				total:
					r.submitted === undefined
						? r.budget.total
						: Math.max(0, r.submitted + r.budget.total - s.now),
			},
			r.trial,
		)
	)
		return reject(s, "InvalidBudget")
	const checked = HashSet.reduce(
		keys(r),
		{ state: s, busy: HashSet.empty<string>(), stale: HashSet.empty<string>() },
		(acc, key) => {
			const current = cell(acc.state, key)
			return {
				state: touch(acc.state, key),
				busy:
					Option.isSome(current.writer) ||
					(HashSet.has(r.writes, key) && HashSet.size(current.readers) > 0)
						? HashSet.add(acc.busy, key)
						: acc.busy,
				stale: !Option.contains(HashMap.get(r.reads, key), current.version)
					? HashSet.add(acc.stale, key)
					: acc.stale,
			}
		},
	)
	if (HashSet.size(checked.busy) > 0)
		return reject(checked.state, "Busy", checked.busy)
	if (HashSet.size(checked.stale) > 0)
		return reject(checked.state, "Stale", checked.stale)
	const old = Option.filter(instance.value.current, (id) => live(s, id))
	const extra = Option.isNone(old) || r.strategy === "Overlap" ? 1 : 0
	if (HashMap.size(s.claims) + extra > s.maxUnits)
		return reject(checked.state, "Capacity")
	const id = `change-${s.nextChange}`
	const oldClaim = Option.flatMap(old, (id) =>
		Option.map(HashMap.get(s.units, id), (u) => u.claim),
	)
	const claims = Option.match(oldClaim, {
		onNone: () => s.claims,
		onSome: (claim) =>
			HashMap.modify(s.claims, claim, (claim) => ({ ...claim, owner: id })),
	})
	const claimId = `${id}/capacity`
	const reserved =
		extra > 0
			? HashMap.set(claims, claimId, {
					id: claimId,
					owner: id,
					unit: Option.none(),
				})
			: claims
	const locks = HashSet.reduce(keys(r), checked.state.cells, (cells, key) => {
		const current = cell(s, key)
		return HashMap.set(
			cells,
			key,
			HashSet.has(r.writes, key)
				? { ...current, writer: Option.some(id) }
				: { ...current, readers: HashSet.add(current.readers, id) },
		)
	})
	const c: Change = {
		resolved: Option.fromNullishOr(r.resolution),
		description: Option.fromNullishOr(r.description),
		policyVersion: r.policyVersion ?? 0,
		id,
		request: r,
		previous: instance.value.desired,
		startingVersion: cell(s, r.instance).version,
		phase: "Resolving",
		interrupted: Option.none(),
		old,
		candidate: Option.none(),
		units: HashSet.fromIterable(Option.toArray(old)),
		requiredExits: HashSet.empty(),
		claims: HashSet.union(
			HashSet.fromIterable(Option.toArray(oldClaim)),
			extra > 0 ? HashSet.make(claimId) : HashSet.empty(),
		),
		premises: r.reads,
		oldChanged: false,
		recovering: false,
		recoveryFailed: false,
		failure: false,
		shuttingDown: false,
		cancelRequested: false,
		authorized: true,
		trialPassed: false,
		view: 1,
		installed: HashSet.empty(),
		requiredParticipants: HashSet.empty(),
		sequence: 0,
		nextCommand: 1,
		commandIds: HashSet.empty(),
		timerIds: HashSet.empty(),
		deadline: (r.submitted ?? s.now) + r.budget.total,
		cause: Cause.empty,
		conclusion: Option.none(),
		transferred: Option.none(),
		released: false,
	}
	const admitted = save(
		{
			...checked.state,
			cells: locks,
			claims: reserved,
			units: Option.match(old, {
				onNone: () => s.units,
				onSome: (unit) =>
					HashMap.modify(s.units, unit, (u) => ({ ...u, owner: id })),
			}),
			active: HashSet.add(s.active, id),
			observers: HashMap.set(
				s.observers,
				r.instance,
				HashSet.add(
					Option.getOrElse(HashMap.get(s.observers, r.instance), () =>
						HashSet.empty(),
					),
					id,
				),
			),
			nextChange: s.nextChange + 1,
			keys:
				r.key === undefined
					? s.keys
					: HashMap.set(s.keys, r.key, { request: r, change: id }),
			reply: { _tag: "Admitted", change: id },
		},
		c,
	)
	const timed = arm(admitted, id, "Total", c.deadline - r.budget.terminate)
	return withChange(timed, id, (s, c) =>
		r.strategy === "Restart" && Option.isSome(old)
			? stopOld(s, c)
			: resolve(s, c),
	)
}
const inspectAttempt = (
	s: Working,
	c: Change,
	resolution: ResolvedInput,
): Working => {
	const free = Arr.findFirst(c.claims, (id) =>
		Option.exists(
			HashMap.get(s.claims, id),
			(claim) => claim.owner === c.id && Option.isNone(claim.unit),
		),
	)
	if (Option.isNone(free))
		return fail(s, c, Cause.fail("Reserved inspection capacity is unavailable"))
	const { key: _key, identity: _identity, ...request } = c.request
	const started = Preparation.start(
		disarm(s, c, HashSet.make("Operation")),
		{ ...request, target: c.recovering ? c.previous : c.request.target },
		true,
		{
			parent: c.id,
			claim: free.value,
			resolution,
			submitted: c.deadline - c.request.budget.total,
		},
	)
	return { ...started, reply: s.reply }
}
const descriptionReady = (
	s: Working,
	ready: Working["descriptions"][number],
): Working =>
	withChange(s, ready.change, (s, c) => {
		if (Option.isSome(c.conclusion)) return s
		if (ready.result._tag !== "Described") return fail(s, c, ready.cause)
		if (c.failure) return progressSettlement(s, c)
		const verified = {
			...c,
			description: Option.some(ready.result.description),
			resolved: ready.resolution,
		}
		return spawn(save(s, verified), verified)
	})
const reportSuccess = (s: Working, c: Change, command: Command): Working => {
	if (Option.isSome(c.conclusion) || c.failure) return s
	switch (command.kind) {
		case "Resolve":
			if (c.phase !== "Resolving") return s
			if (
				!Preparation.authorized(
					s,
					c.request.instance,
					c.recovering ? c.previous : c.request.target,
				)
			)
				return fail(s, c, Cause.fail("Current policy denies execution"))
			if (
				Option.isSome(command.report) &&
				command.report.value._tag === "Resolved"
			) {
				const resolved = {
					...c,
					resolved: Option.some(command.report.value.value),
					policyVersion: Preparation.policy(s, c.request.instance).version,
				}
				const target = c.recovering ? c.previous : c.request.target
				const known = Preparation.cached(s, target, command.report.value.value)
				if (target.deployment === undefined)
					return spawn(save(s, resolved), resolved)
				if (Option.isSome(known)) {
					const verified = {
						...resolved,
						description: Option.some(known.value.description),
					}
					return spawn(save(s, verified), verified)
				}
				return inspectAttempt(
					save(s, resolved),
					resolved,
					command.report.value.value,
				)
			}
			return spawn(s, c)
		case "Spawn":
			return c.phase === "Spawning"
				? withUnit(s, command.unit, (s, u) =>
						operation(
							{
								...s,
								units: HashMap.set(s.units, u.id, { ...u, phase: "Running" }),
							},
							c,
							"Start",
							"Starting",
							u.id,
							c.request.budget.startup,
						),
					)
				: s
		case "Start":
			if (Option.isSome(c.description)) {
				const evidence = command.report
				if (
					!Option.exists(
						evidence,
						(r) =>
							r._tag === "Started" &&
							Equal.equals(r.value, c.description.pipe(Option.getOrUndefined)),
					)
				)
					return fail(
						s,
						c,
						Cause.fail("Execution declarations differ from inspection"),
					)
			}
			return c.phase === "Starting"
				? operation(
						s,
						c,
						"Serve",
						"Serving",
						command.unit,
						c.request.budget.startup,
					)
				: s
		case "Serve":
			return c.phase === "Serving"
				? operation(
						s,
						c,
						"Ready",
						"Readiness",
						command.unit,
						c.request.budget.startup,
					)
				: s
		case "Ready":
			return c.phase === "Readiness"
				? operation(
						s,
						c,
						"Probe",
						"Probing",
						command.unit,
						c.request.budget.probe,
					)
				: s
		case "Probe":
			return c.phase === "Probing" ? install(s, c, command.unit) : s
		case "Install": {
			if (
				c.phase !== "Installing" ||
				command.token.view !== c.view ||
				!HashSet.has(c.requiredParticipants, command.participant)
			)
				return s
			const next = {
				...c,
				installed: HashSet.add(c.installed, command.participant),
			}
			const saved = save(s, next)
			return HashSet.every(next.requiredParticipants, (p) =>
				HashSet.has(next.installed, p),
			)
				? commit(saved, next)
				: saved
		}
		case "Activate":
		case "Stop":
		case "Terminate":
		case "ArmTimer":
		case "Describe":
		case "PublishPreparation":
		case "Publish":
		case "CancelTimer":
			return s
	}
}
const endUnit = (
	s: Working,
	u: Unit,
	evidence: Unit["evidence"],
	cleanup: Unit["cleanup"],
	cause: Cause.Cause<unknown>,
): Working => {
	if (u.evidence !== "Missing") return s
	const ended: Unit = {
		...u,
		evidence,
		phase: evidence === "NotStarted" ? "NotStarted" : "Exited",
		cleanup: cleanup._tag === "Unknown" ? u.cleanup : cleanup,
		cause: Cause.combine(u.cause, cause),
		leases: HashSet.empty(),
	}
	const claim = HashMap.get(s.claims, u.claim)
	const next: Working = {
		...s,
		changed: HashSet.union(
			s.changed,
			Option.getOrElse(HashMap.get(s.observers, u.instance), () =>
				HashSet.empty(),
			),
		),
		units: HashMap.set(s.units, u.id, ended),
		claims: Option.match(claim, {
			onNone: () => s.claims,
			onSome: (claim) =>
				claim.owner === instanceOwner(u.instance)
					? HashMap.remove(s.claims, u.claim)
					: HashMap.set(s.claims, u.claim, { ...claim, unit: Option.none() }),
		}),
		instances: HashMap.modify(s.instances, u.instance, (i) =>
			Option.contains(i.current, u.id) ? { ...i, healthy: false } : i,
		),
	}
	return withChange(next, u.owner, (s, c) => {
		const observed = {
			...c,
			cause: Cause.combine(
				c.cause,
				cleanup._tag === "Failed" ? Cause.combine(cause, cleanup.cause) : cause,
			),
		}
		const saved = save(s, observed)
		if (Option.isSome(c.conclusion)) return release(saved, observed)
		if (cleanup._tag === "Failed" && !c.failure)
			return fail(saved, observed, Cause.empty)
		if (Option.contains(c.candidate, u.id) && !c.failure)
			return fail(saved, observed, Cause.fail("Candidate execution exited"))
		if (
			Option.contains(c.old, u.id) &&
			!HashSet.has(c.requiredExits, u.id) &&
			!c.failure
		)
			return fail(
				saved,
				observed,
				Cause.fail("Previous execution exited unexpectedly"),
			)
		return progressSettlement(saved, observed)
	})
}
const currentReport = (c: Change, command: Command): boolean =>
	command.token.view === c.view &&
	(command.kind === "Resolve" ||
		command.kind === "Stop" ||
		command.kind === "Terminate" ||
		command.kind === "ArmTimer" ||
		command.kind === "Publish" ||
		Option.contains(c.candidate, command.unit))
const reported = (
	s: Working,
	event: Extract<Event, { readonly _tag: "Reported" }>,
): Working =>
	Option.match(HashMap.get(s.commands, event.command), {
		onNone: () => s,
		onSome: (command) => {
			if (
				command.disposition === "Reported" ||
				!Equal.equals(command.token, event.token)
			)
				return s
			const recorded: Working = {
				...s,
				commands: HashMap.set(s.commands, command.id, {
					...command,
					disposition: "Reported",
					report: Option.some(event.result),
				}),
			}
			if (command.change === "$runtime")
				return event.result._tag === "Failed"
					? withUnit(recorded, command.unit, (s, u) => ({
							...s,
							units: HashMap.set(s.units, u.id, {
								...u,
								cause: Cause.combine(
									u.cause,
									event.result._tag === "Failed"
										? event.result.cause
										: Cause.empty,
								),
							}),
						}))
					: recorded
			return withChange(recorded, command.change, (s, c) => {
				if (
					event.result._tag === "Succeeded" ||
					event.result._tag === "Resolved" ||
					event.result._tag === "Started" ||
					event.result._tag === "Described"
				)
					return command.disposition === "Obsolete" ||
						!currentReport(c, command)
						? s
						: reportSuccess(s, c, {
								...command,
								report: Option.some(event.result),
							})
				const result = event.result
				if (command.kind === "Stop" && result.delivery === "Unavailable")
					return save(s, { ...c, cause: Cause.combine(c.cause, result.cause) })
				const failed =
					Option.isSome(c.conclusion) || !currentReport(c, command)
						? save(s, { ...c, cause: Cause.combine(c.cause, result.cause) })
						: fail(s, c, result.cause)
				return command.kind === "Spawn" && result.creation === "NotStarted"
					? withUnit(failed, command.unit, (s, u) =>
							u.phase === "PendingSpawn" || u.phase === "Terminating"
								? endUnit(s, u, "NotStarted", { _tag: "Unknown" }, Cause.empty)
								: s,
						)
					: failed
			})
		},
	})
const timerFired = (
	s: Working,
	event: Extract<Event, { readonly _tag: "TimerFired" }>,
): Working =>
	Option.match(HashMap.get(s.timers, event.timer), {
		onNone: () => s,
		onSome: (timer) => {
			if (
				!timer.active ||
				timer.generation !== event.generation ||
				event.now < timer.deadline
			)
				return s
			const fired = {
				...s,
				timers: HashMap.set(s.timers, timer.id, { ...timer, active: false }),
			}
			return withChange(fired, timer.change, (s, c) => {
				if (Option.isSome(c.conclusion)) return s
				switch (timer.purpose) {
					case "Trial": {
						if (c.phase !== "Trial") return s
						const passed = { ...c, trialPassed: true }
						return c.recovering ||
							c.request.strategy === "Restart" ||
							Option.isNone(c.old)
							? conclude(
									save(s, passed),
									passed,
									c.recovering ? "Recovered" : "Accepted",
								)
							: stopOld(save(s, passed), passed)
					}
					case "Operation": {
						if (c.phase === "Retiring" && c.trialPassed && !c.failure) {
							const forced = {
								...c,
								cause: Cause.combine(
									c.cause,
									Cause.fail("Retirement deadline required forced termination"),
								),
							}
							return arm(
								terminate(save(s, forced), forced, c.requiredExits),
								c.id,
								"Evidence",
								Num.min(s.now + c.request.budget.terminate, c.deadline),
							)
						}
						return fail(s, c, Cause.fail(`${c.phase} deadline expired`))
					}
					case "Total":
						return fail(
							s,
							c,
							Cause.fail("Absolute submission deadline exhausted"),
						)
					case "Evidence":
						return settled(s, c.requiredExits)
							? progressSettlement(s, c)
							: conclude(
									s,
									{
										...c,
										cause: Cause.combine(
											c.cause,
											Cause.fail("Required exit evidence is missing"),
										),
									},
									"Stuck",
								)
				}
			})
		},
	})
const invalidated = (
	s: Working,
	event: Extract<Event, { readonly _tag: "Invalidated" }>,
): Working => {
	const current = cell(s, event.object)
	const next = {
		...touch(s, event.object),
		instances: HashMap.modify(s.instances, event.object, (i) => ({
			...i,
			healthy: false,
			authorized: false,
		})),
		cells: HashMap.set(s.cells, event.object, {
			...current,
			version: current.version + 1,
			value: Option.none<string>(),
		}),
	}
	const owners = HashSet.union(
		current.readers,
		HashSet.fromIterable(Option.toArray(current.writer)),
	)
	return HashSet.reduce(owners, next, (s, id) =>
		withChange(s, id, (s, c) =>
			fail(s, { ...c, authorized: false }, event.cause),
		),
	)
}
const shutdownUnit = (s: Working, u: Unit): Working => {
	if (u.evidence !== "Missing" || u.phase === "Terminating") return s
	const id = `${s.authority}/shutdown/${u.id}`
	const command: Command = {
		dispatched: true,
		id,
		change: "$runtime",
		kind: "Terminate",
		unit: u.id,
		target: u.target,
		participant: "",
		timer: Option.none(),
		status: Option.none(),
		disposition: "Pending",
		report: Option.none(),
		token: {
			authority: s.authority,
			change: "$runtime",
			unit: u.id,
			incarnation: u.incarnation,
			term: u.term,
			view: 0,
		},
	}
	return {
		...s,
		units: HashMap.set(s.units, u.id, { ...u, phase: "Terminating" }),
		commands: HashMap.set(s.commands, id, command),
		emitted: Arr.append(s.emitted, command),
	}
}
const shutdown = (s: Working): Working => {
	const closing: Working = {
		...s,
		open: false,
		instances: HashMap.map(s.instances, (i) => ({ ...i, healthy: false })),
		changed: HashMap.reduce(s.observers, s.changed, (ids, observed) =>
			HashSet.union(ids, observed),
		),
	}
	const cancelled = HashSet.reduce(s.active, closing, (s, id) =>
		withChange(s, id, (s, c) =>
			c.shuttingDown
				? s
				: fail(
						s,
						{ ...c, shuttingDown: true, oldChanged: true },
						Cause.fail("Runtime shut down"),
					),
		),
	)
	return HashMap.reduce(cancelled.units, cancelled, shutdownUnit)
}
const timerEnded = (
	s: Working,
	event: Extract<Event, { readonly _tag: "TimerEnded" }>,
): Working =>
	Option.match(HashMap.get(s.timers, event.timer), {
		onNone: () => s,
		onSome: (t) => {
			if (t.generation !== event.generation) return s
			const recorded = {
				...s,
				timers: HashMap.set(s.timers, t.id, {
					...t,
					active: false,
					cause: Cause.combine(t.cause, event.cause),
				}),
			}
			if (!t.active || event.cause.reasons.length === 0) return recorded
			return withChange(recorded, t.change, (s, c) => {
				const failed = fail(s, c, event.cause)
				return t.purpose === "Evidence"
					? withChange(failed, c.id, (s, c) =>
							classify(s, c) === "Unresolved"
								? conclude(s, c, "Stuck")
								: progressSettlement(s, c),
						)
					: failed
			})
		},
	})
const policyChanged = (
	s: Working,
	event: Extract<Event, { _tag: "PolicyChanged" }>,
): Working => {
	const previous = Preparation.policy(s, event.instance)
	const next: Working = {
		...s,
		policies: HashMap.set(s.policies, event.instance, {
			version: previous.version + 1,
			allowed: Option.some(HashSet.fromIterable(event.allowed)),
			values: InputSnapshot.values(event.values),
		}),
		instances: HashMap.modify(s.instances, event.instance, (i) => ({
			...i,
			authorized: HashSet.has(
				HashSet.fromIterable(event.allowed),
				i.desired.identity,
			),
		})),
	}
	return HashSet.reduce(
		Option.getOrElse(HashMap.get(s.observers, event.instance), () =>
			HashSet.empty(),
		),
		next,
		(s, id) =>
			withChange(s, id, (s, c) =>
				Option.isSome(c.conclusion)
					? s
					: fail(s, c, Cause.fail("Current authorization premise changed")),
			),
	)
}
const eventPreparations = (s: State, event: Event): HashSet.HashSet<string> => {
	switch (event._tag) {
		case "PreparationObserved":
			return HashSet.make(event.preparation)
		case "Reported":
			return HashSet.fromIterable(
				Option.toArray(
					Option.map(HashMap.get(s.commands, event.command), (c) => c.change),
				),
			)
		case "UnitCleanup":
		case "UnitDisconnected":
		case "UnitDiagnostic":
		case "UnitProgress":
		case "UnitFailed":
		case "Exited":
			return HashSet.fromIterable(
				Option.toArray(
					Option.map(HashMap.get(s.units, event.unit), (u) => u.owner),
				),
			)
		case "TimerFired":
		case "TimerEnded":
			return HashSet.fromIterable(
				Option.toArray(
					Option.map(HashMap.get(s.timers, event.timer), (t) => t.change),
				),
			)
		default:
			return HashSet.empty()
	}
}
const unitFailed = (
	s: Working,
	event: Extract<Event, { _tag: "UnitFailed" }>,
): Working =>
	withUnit(s, event.unit, (s, u) => {
		if (u.incarnation !== event.incarnation || u.spawn !== event.observer)
			return s
		const changed = Option.getOrElse(HashMap.get(s.observers, u.instance), () =>
			HashSet.empty<string>(),
		)
		const observed: Working = {
			...s,
			units: HashMap.set(s.units, u.id, {
				...u,
				cause: Cause.combine(u.cause, event.cause),
			}),
			instances: HashMap.modify(s.instances, u.instance, (i) =>
				Option.contains(i.current, u.id) ? { ...i, healthy: false } : i,
			),
			changed: HashSet.union(s.changed, changed),
		}
		const failed = HashSet.reduce(
			HashSet.add(changed, u.owner),
			observed,
			(s, id) =>
				withChange(s, id, (s, c) =>
					Option.isSome(c.conclusion)
						? s
						: fail(
								s,
								{
									...c,
									oldChanged: c.oldChanged || Option.contains(c.old, u.id),
								},
								event.cause,
							),
				),
		)
		return u.owner === instanceOwner(u.instance)
			? withUnit(failed, u.id, shutdownUnit)
			: failed
	})
const unitCleanup = (
	s: Working,
	event: Extract<Event, { _tag: "UnitCleanup" }>,
): Working =>
	withUnit(s, event.unit, (s, u) =>
		u.incarnation !== event.incarnation || u.spawn !== event.observer
			? s
			: {
					...s,
					units: HashMap.set(s.units, u.id, {
						...u,
						cleanup: event.cleanup,
						cause: Cause.combine(u.cause, event.cause),
					}),
				},
	)
const disconnected = (
	s: Working,
	event: Extract<Event, { _tag: "UnitDisconnected" }>,
): Working =>
	withUnit(s, event.unit, (s, u) => {
		if (u.incarnation !== event.incarnation || u.spawn !== event.observer)
			return s
		const owners = HashSet.add(
			Option.getOrElse(HashMap.get(s.observers, u.instance), () =>
				HashSet.empty<string>(),
			),
			u.owner,
		)
		const stopping =
			!s.open ||
			HashSet.some(owners, (owner) =>
				Option.exists(HashMap.get(s.changes, owner), (c) =>
					HashSet.some(c.commandIds, (id) =>
						Option.exists(
							HashMap.get(s.commands, id),
							(command) => command.unit === u.id && command.kind === "Stop",
						),
					),
				),
			) ||
			u.kind === "Inspection"
		return stopping
			? {
					...s,
					units: HashMap.set(s.units, u.id, {
						...u,
						cause: Cause.combine(u.cause, event.cause),
					}),
				}
			: unitFailed(s, { ...event, _tag: "UnitFailed" })
	})
const apply = (s: Working, event: Event): Working => {
	switch (event._tag) {
		case "UnitDiagnostic":
			return withUnit(s, event.unit, (s, u) =>
				u.incarnation !== event.incarnation || u.spawn !== event.observer
					? s
					: {
							...s,
							units: HashMap.set(s.units, u.id, {
								...u,
								cause: Cause.combine(u.cause, event.cause),
							}),
						},
			)
		case "UnitCleanup":
			return unitCleanup(s, event)
		case "UnitDisconnected":
			return Option.exists(
				HashMap.get(s.units, event.unit),
				(u) => u.kind === "Inspection",
			)
				? Preparation.nativeFailure(s, event)
				: disconnected(s, event)
		case "UnitProgress":
			return withUnit(s, event.unit, (s, u) =>
				u.incarnation !== event.incarnation || u.spawn !== event.observer
					? s
					: {
							...s,
							units: HashMap.set(s.units, u.id, {
								...u,
								progress: event.stage,
							}),
						},
			)
		case "UnitFailed":
			return Option.exists(
				HashMap.get(s.units, event.unit),
				(u) => u.kind === "Inspection",
			)
				? Preparation.nativeFailure(s, event)
				: unitFailed(s, event)
		case "TimerEnded":
			return Option.exists(HashMap.get(s.timers, event.timer), (t) =>
				HashMap.has(s.preparations, t.change),
			)
				? Preparation.timerEnded(s, event)
				: timerEnded(s, event)
		case "Requested":
			return requested(s, event.request)
		case "InspectRequested":
			return requested(s, event.request, true)
		case "PreparationObserved":
			return Preparation.observed(s, event.preparation)
		case "PolicyChanged":
			return policyChanged(s, event)
		case "Observed":
			return withChange(s, event.change, save)
		case "Submit":
			return submit(s, event.request)
		case "Reported":
			return Option.exists(HashMap.get(s.commands, event.command), (c) =>
				HashMap.has(s.preparations, c.change),
			)
				? Preparation.reported(s, event)
				: reported(s, event)
		case "Exited":
			if (
				Option.exists(
					HashMap.get(s.units, event.unit),
					(u) =>
						u.kind === "Inspection" && HashMap.has(s.preparations, u.owner),
				)
			)
				return Preparation.exited(s, event)
			return withUnit(s, event.unit, (s, u) =>
				u.incarnation === event.incarnation && u.spawn === event.observer
					? endUnit(s, u, "Exited", event.cleanup, event.cause)
					: s,
			)
		case "TimerFired":
			return Option.exists(HashMap.get(s.timers, event.timer), (t) =>
				HashMap.has(s.preparations, t.change),
			)
				? Preparation.timer(s, event)
				: timerFired(s, event)
		case "Cancel":
			return withChange(s, event.change, (s, c) =>
				c.cancelRequested
					? s
					: fail(s, { ...c, cancelRequested: true }, event.cause),
			)
		case "Invalidated":
			return invalidated(s, event)
		case "Shutdown":
			return Preparation.shutdown(shutdown(s))
	}
}
const eventOwners = (s: State, event: Event): HashSet.HashSet<string> => {
	switch (event._tag) {
		case "Observed":
			return HashSet.make(event.change)
		case "InspectRequested":
		case "PreparationObserved":
		case "PolicyChanged":
		case "Requested":
		case "Submit":
			return HashSet.empty()
		case "Reported":
			return HashSet.fromIterable(
				Option.toArray(
					Option.map(HashMap.get(s.commands, event.command), (c) => c.change),
				),
			)
		case "UnitCleanup":
		case "UnitDisconnected":
		case "UnitDiagnostic":
		case "UnitProgress":
		case "UnitFailed":
		case "Exited":
			return HashSet.fromIterable(
				Option.toArray(
					Option.map(HashMap.get(s.units, event.unit), (u) => u.owner),
				),
			)
		case "TimerEnded":
		case "TimerFired":
			return HashSet.fromIterable(
				Option.toArray(
					Option.map(HashMap.get(s.timers, event.timer), (t) => t.change),
				),
			)
		case "Cancel":
			return HashSet.make(event.change)
		case "Invalidated": {
			const current = cell(s, event.object)
			return HashSet.union(
				current.readers,
				HashSet.fromIterable(Option.toArray(current.writer)),
			)
		}
		case "Shutdown":
			return s.active
	}
}
const expireObservedDeadlines = (s: Working, id: string): Working =>
	withChange(s, id, (s, c) => {
		if (Option.isSome(c.conclusion)) return s
		const due = HashSet.reduce(c.timerIds, Option.none<Timer>(), (first, id) =>
			Option.match(HashMap.get(s.timers, id), {
				onNone: () => first,
				onSome: (t) =>
					t.active &&
					t.purpose !== "Trial" &&
					t.deadline < s.now &&
					(Option.isNone(first) || t.deadline < first.value.deadline)
						? Option.some(t)
						: first,
			}),
		)
		return Option.match(due, {
			onNone: () => s,
			onSome: (t) =>
				expireObservedDeadlines(
					timerFired(s, {
						_tag: "TimerFired",
						timer: t.id,
						generation: t.generation,
						now: s.now,
					}),
					id,
				),
		})
	})
export const reduce = (state: State, incoming: Event): Transition => {
	const event: Event =
		incoming._tag === "Reported"
			? { ...incoming, result: InputSnapshot.report(incoming.result) }
			: incoming
	const before: Working = {
		...state,
		now: Num.max(state.now, event.now),
		emitted: [],
		changed: HashSet.empty(),
		preparationsChanged: HashSet.empty(),
		admissions: [],
		descriptions: [],
		reply: { _tag: "None" },
	}
	const timed = HashSet.reduce(
		eventOwners(state, event),
		before,
		expireObservedDeadlines,
	)
	const prepTimed = HashSet.reduce(
		eventPreparations(state, event),
		timed,
		Preparation.expire,
	)
	const appliedEvent = apply(prepTimed, event)
	const applied = Arr.reduce(
		appliedEvent.admissions,
		appliedEvent,
		(s, ready) =>
			Preparation.admitResult(submit(s, ready.request), ready.preparation),
	)
	const parents = HashSet.reduce(
		eventPreparations(state, event),
		HashSet.empty<string>(),
		(ids, id) =>
			Option.match(HashMap.get(state.preparations, id), {
				onNone: () => ids,
				onSome: (p) =>
					p.parent === undefined ? ids : HashSet.add(ids, p.parent),
			}),
	)
	const settledParents = HashSet.reduce(parents, applied, (s, id) =>
		withChange(s, id, progressSettlement),
	)
	const described = Arr.reduce(
		settledParents.descriptions,
		settledParents,
		descriptionReady,
	)
	const revised = HashSet.reduce(described.changed, described, (s, id) =>
		withChange(s, id, (s, c) => {
			const previous = HashMap.get(state.changes, id)
			return Option.isNone(previous) ||
				!Equal.equals(get(state, id), get(s, id))
				? save(s, { ...c, sequence: c.sequence + 1 })
				: s
		}),
	)
	const cancelled = HashSet.reduce(revised.changed, revised, (s, id) =>
		withChange(s, id, (s, c) =>
			HashSet.reduce(c.timerIds, s, (s, timerId) => {
				const before = HashMap.get(state.timers, timerId)
				const after = HashMap.get(s.timers, timerId)
				return Option.exists(before, (t) => t.active) &&
					Option.exists(after, (t) => !t.active)
					? issue(s, c.id, "CancelTimer", "", "", Option.some(timerId))
					: s
			}),
		),
	)
	const published = HashSet.reduce(cancelled.changed, cancelled, (s, id) =>
		withChange(s, id, (s, c) => {
			const previous = HashMap.get(state.changes, id)
			return Option.isNone(previous) || c.sequence > previous.value.sequence
				? issue(s, id, "Publish")
				: s
		}),
	)
	const prepared = Preparation.publish(
		state,
		Preparation.cancelTimers(state, published),
	)
	const {
		emitted: commands,
		reply,
		changed: _changed,
		preparationsChanged: _preparationsChanged,
		admissions: _admissions,
		descriptions: _descriptions,
		...next
	} = prepared
	return { state: next, commands, reply }
}
