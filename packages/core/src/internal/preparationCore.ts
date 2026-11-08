import { Array, Cause, Equal, HashMap, HashSet, Option } from "effect"

import type {
	Command,
	CommandKind,
	Description,
	DescriptionKey,
	Event,
	GraphProposal,
	Policy,
	Preparation,
	PreparationResult,
	PreparationStatus,
	Rejection,
	Report,
	Request,
	ResolvedInput,
	State,
	Target,
	Timer,
	TimerPurpose,
	Unit,
	UnitMember,
	Working,
} from "./decisionState"
import * as Executions from "./executionState"
import * as Grants from "./memberGrant"

const timerPurposes = (
	...values: ReadonlyArray<TimerPurpose>
): HashSet.HashSet<TimerPurpose> => HashSet.fromIterable(values)
export const policy = (s: State, instance: string): Policy =>
	Option.getOrElse(HashMap.get(s.policies, instance), () => ({
		version: 0,
		allowed: Option.none(),
		sandbox: false,
		values: {},
	}))
export const authorized = (
	s: State,
	instance: string,
	target: Target,
): boolean =>
	(!policy(s, instance).sandbox ||
		(target.placement === "Process" &&
			target.deployment?.confinement === "Sandbox")) &&
	Option.match(policy(s, instance).allowed, {
		onNone: () => true,
		onSome: (allowed) => HashSet.has(allowed, target.identity),
	})
const descriptionKey = (request: Request): DescriptionKey => ({
	boundary: request.boundary ??
		request.placement ?? { kind: request.target.placement },
	target: { ...request.target, overlap: false },
	instance: request.instance,
	realm: request.realm ?? "root",
	colocate: request.colocate ?? [],
	placement: Option.fromNullishOr(request.placement),
})
export const cached = (
	s: State,
	request: Request,
	resolution?: ResolvedInput,
) =>
	Option.filter(
		HashMap.get(s.verified, descriptionKey(request)),
		(value) =>
			resolution === undefined || Equal.equals(value.resolution, resolution),
	)
/** Compile inspected declarations into intent; the reducer derives the closure. */
export const proposal = (
	s: State,
	r: Request,
	d: Description,
): GraphProposal => {
	const retained = HashSet.fromIterable(Array.map(d.members, (m) => m.instance))
	const descendants = (
		ids: HashSet.HashSet<string>,
	): HashSet.HashSet<string> => {
		const next = HashSet.reduce(ids, ids, (all, id) =>
			HashSet.union(
				all,
				Option.getOrElse(HashMap.get(s.graph.children, id), () =>
					HashSet.empty<string>(),
				),
			),
		)
		return HashSet.size(next) === HashSet.size(ids) ? next : descendants(next)
	}
	return {
		members: d.members,
		removed: HashSet.difference(
			descendants(
				r.operations === undefined
					? HashSet.make(r.instance)
					: HashSet.fromIterable(
							Array.map(r.operations, (operation) => operation.instance),
						),
			),
			retained,
		),
		explicit:
			r.operations === undefined
				? HashSet.make(r.instance)
				: HashSet.fromIterable(
						Array.map(r.operations, (operation) => operation.instance),
					),
		realms: r.realms ?? [],
	}
}
export const get = (s: State, id: string): Option.Option<PreparationStatus> =>
	Option.map(HashMap.get(s.preparations, id), (p) => {
		const unit = HashMap.get(s.units, p.unit)
		return {
			id: p.id,
			sequence: p.sequence,
			phase: p.phase,
			interrupted: p.interrupted,
			instance: p.request.instance,
			unit: p.unit,
			remaining: Math.max(0, p.deadline - s.now),
			unconfirmedUnits: Option.exists(unit, (u) => u.evidence === "Missing")
				? HashSet.make(p.unit)
				: HashSet.empty(),
			exitEvidence: Option.match(unit, {
				onNone: () => "NotStarted",
				onSome: (u) => u.evidence,
			}),
			cleanup: Option.match(unit, {
				onNone: () => ({ _tag: "Unknown" }),
				onSome: (u) => u.cleanup,
			}),
			cause: p.cause,
			result: p.result,
		}
	})
const save = (s: Working, p: Preparation): Working => ({
	...s,
	preparations: HashMap.set(s.preparations, p.id, p),
	preparationsChanged: HashSet.add(s.preparationsChanged, p.id),
})
const update = (
	s: Working,
	id: string,
	f: (s: Working, p: Preparation) => Working,
): Working =>
	Option.match(HashMap.get(s.preparations, id), {
		onNone: () => s,
		onSome: (p) => f(s, p),
	})
const emit = (
	s: Working,
	p: Preparation,
	kind: CommandKind,
	dispatched = true,
	fixedId?: string,
	timerId: Option.Option<string> = Option.none(),
): Working => {
	const unit = HashMap.get(s.units, p.unit)
	const id = fixedId ?? `${p.id}/${p.nextCommand}`
	const command: Command = {
		subjects: Option.match(unit, {
			onNone: HashSet.empty<string>,
			onSome: (unit) => HashSet.fromIterable(HashMap.keys(unit.members)),
		}),
		placement: p.request.boundary ??
			p.request.placement ?? { kind: p.request.target.placement },
		resolutions: Option.match(p.resolution, {
			onNone: HashMap.empty<string, ResolvedInput>,
			onSome: (resolution) => HashMap.make([p.request.instance, resolution]),
		}),
		descriptions: HashMap.empty(),
		policies: HashMap.make([p.request.instance, policy(s, p.request.instance)]),
		members: Option.getOrElse(
			Option.map(unit, (u) => Executions.grants(u.members)),
			HashMap.empty<string, UnitMember>,
		),
		id,
		dispatched,
		change: p.id,
		kind,
		unit: p.unit,
		target: p.request.target,
		participant: "",
		timer: timerId,
		status: Option.none(),
		disposition: "Pending",
		report: Option.none(),
		token: {
			authority: s.authority,
			change: p.id,
			unit: p.unit,
			incarnation: Option.getOrElse(
				Option.map(unit, (u) => u.incarnation),
				() => `${s.authority}/${p.unit}`,
			),
			members: Option.match(unit, {
				onNone: HashMap.empty,
				onSome: (unit) => Executions.tokens(unit.members),
			}),
			view: 0,
		},
		policy: policy(s, p.request.instance),
		...(Option.isSome(p.resolution) ? { resolution: p.resolution.value } : {}),
		...Option.getOrElse(
			Option.map(
				kind === "PublishPreparation"
					? get(s, p.id)
					: Option.none<PreparationStatus>(),
				(preparation) => ({ preparation }),
			),
			() => ({}),
		),
	}
	return save(
		{
			...s,
			commands: HashMap.set(s.commands, id, command),
			emitted: dispatched ? Array.append(s.emitted, command) : s.emitted,
		},
		{
			...p,
			nextCommand: p.nextCommand + 1,
			commandIds: HashSet.add(p.commandIds, id),
		},
	)
}
const issue = (s: Working, id: string, kind: CommandKind): Working =>
	update(s, id, (s, p) => emit(s, p, kind))
const disarm = (
	s: Working,
	p: Preparation,
	purposes: HashSet.HashSet<TimerPurpose>,
): Working => ({
	...s,
	timers: HashSet.reduce(p.timerIds, s.timers, (timers, id) =>
		HashMap.modify(timers, id, (t) =>
			HashSet.has(purposes, t.purpose) ? { ...t, active: false } : t,
		),
	),
})
const arm = (
	s: Working,
	id: string,
	purpose: TimerPurpose,
	deadline: number,
): Working =>
	update(s, id, (s, p) => {
		const timer: Timer = {
			id: `${id}/timer/${p.nextCommand}`,
			change: id,
			generation: p.nextCommand,
			purpose,
			deadline: Math.min(
				deadline,
				purpose === "Evidence"
					? p.deadline
					: p.deadline - p.request.budget.terminate,
			),
			active: true,
			command: Option.none(),
			cause: Cause.empty,
		}
		const next = save(
			{ ...s, timers: HashMap.set(s.timers, timer.id, timer) },
			{
				...p,
				nextCommand: p.nextCommand + 1,
				timerIds: HashSet.add(p.timerIds, timer.id),
			},
		)
		return update(next, id, (s, p) =>
			emit(s, p, "ArmTimer", true, undefined, Option.some(timer.id)),
		)
	})
const operation = (
	s: Working,
	p: Preparation,
	kind: CommandKind,
	phase: Preparation["phase"],
	budget: number,
): Working =>
	arm(
		issue(
			save(disarm(s, p, timerPurposes("Operation")), {
				...p,
				phase,
			}),
			p.id,
			kind,
		),
		p.id,
		"Operation",
		s.now + budget,
	)
const ended = (s: State, p: Preparation): boolean =>
	Option.exists(HashMap.get(s.units, p.unit), (u) => u.evidence !== "Missing")
const evict = (s: Working, id: string): Working =>
	update(s, id, (s, p) => ({
		...s,
		preparations: HashMap.remove(s.preparations, id),
		commands: HashSet.reduce(p.commandIds, s.commands, (m, id) =>
			HashMap.remove(m, id),
		),
		timers: HashSet.reduce(p.timerIds, s.timers, (m, id) =>
			HashMap.remove(m, id),
		),
		units: HashSet.reduce(p.inspectionUnits, s.units, (units, id) =>
			HashMap.remove(units, id),
		),
		preparationsChanged: HashSet.remove(s.preparationsChanged, id),
	}))
const release = (s: Working, p: Preparation): Working => {
	const released = {
		...s,
		claims:
			p.parent === undefined
				? HashMap.remove(s.claims, p.claim)
				: HashMap.modify(s.claims, p.claim, (claim) => ({
						...claim,
						owner: p.parent ?? claim.owner,
						unit: Option.none(),
					})),
	}
	const current = HashMap.get(released.preparations, p.id)
	if (
		Option.isNone(current) ||
		current.value.archived ||
		Option.isNone(current.value.result)
	)
		return released
	const retained = save(released, { ...current.value, archived: true })
	const preparationKeys =
		p.request.key !== undefined &&
		Option.contains(HashMap.get(s.preparationKeys, p.request.key), p.id)
			? HashMap.remove(s.preparationKeys, p.request.key)
			: s.preparationKeys
	const history = Array.append(s.preparationHistory, p.id)
	const next = { ...retained, preparationKeys, preparationHistory: history }
	return history.length <= Math.max(1, s.historyLimit)
		? next
		: Option.match(Array.head(history), {
				onNone: () => next,
				onSome: (id) =>
					evict({ ...next, preparationHistory: Array.drop(history, 1) }, id),
			})
}

const result = (
	s: Working,
	p: Preparation,
	value: PreparationResult,
): Working => {
	if (Option.isSome(p.result)) return s
	const next = save(
		disarm(s, p, timerPurposes("Total", "Operation", "Evidence")),
		{ ...p, phase: "Concluded", result: Option.some(value) },
	)
	const completed =
		p.parent === undefined
			? next
			: {
					...next,
					descriptions: Array.append(next.descriptions, {
						change: p.parent,
						result: value,
						cause: p.cause,
						resolution: p.resolution,
					}),
				}
	return ended(completed, p) ? release(completed, p) : completed
}
const reject = (
	s: Working,
	p: Preparation,
	reason: Rejection,
	conflicts = HashSet.empty<string>(),
): Working => {
	const next = result(s, p, { _tag: "Rejected", reason, conflicts })
	return {
		...next,
		reply: {
			_tag: "Rejected",
			reason,
			conflicts,
			preparation: p.id,
			cause: p.cause,
		},
	}
}
const prevent = (s: Working, p: Preparation): Working => {
	const unit = HashMap.get(s.units, p.unit)
	if (Option.isNone(unit)) return s
	const spawn = HashMap.get(s.commands, unit.value.spawn)
	if (Option.isNone(spawn) || spawn.value.dispatched) return s
	return {
		...s,
		commands: HashMap.set(s.commands, spawn.value.id, {
			...spawn.value,
			disposition: "Obsolete",
		}),
		units: HashMap.set(s.units, p.unit, {
			...unit.value,
			phase: "NotStarted",
			evidence: "NotStarted",
		}),
	}
}
const fail = (
	s: Working,
	p: Preparation,
	reason: Rejection,
	cause: Cause.Cause<unknown>,
): Working => {
	const next = {
		...p,
		interrupted: Option.orElse(p.interrupted, () => Option.some(p.phase)),
		failure: Option.some(reason),
		cause: Cause.combine(p.cause, cause),
	}
	const prevented = prevent(
		save(
			{
				...s,
				units: HashMap.modify(s.units, p.unit, (u) =>
					u.evidence === "Missing" ? { ...u, phase: "Terminating" } : u,
				),
			},
			next,
		),
		next,
	)
	if (ended(prevented, next)) return reject(prevented, next, reason)
	if (p.phase === "Terminating" || Option.isSome(p.result))
		return save(prevented, next)
	return arm(
		issue(
			save(disarm(prevented, next, timerPurposes("Operation")), {
				...next,
				phase: "Terminating",
			}),
			p.id,
			"Terminate",
		),
		p.id,
		"Evidence",
		s.now + p.request.budget.terminate,
	)
}
const identified = (p: Preparation, d: Description): boolean => {
	const ids = HashSet.fromIterable(Array.map(d.members, (m) => m.instance))
	if (HashSet.size(ids) !== d.members.length) return false
	const descends = (id: string, seen: HashSet.HashSet<string>): boolean => {
		if (id === p.request.instance) return true
		if (HashSet.has(seen, id)) return false
		return Option.exists(
			Array.findFirst(d.members, (m) => m.instance === id),
			(m) =>
				Option.exists(m.parent, (parent) =>
					descends(parent, HashSet.add(seen, id)),
				),
		)
	}
	return Array.every(d.members, (m) => descends(m.instance, HashSet.empty()))
}
const valid = (p: Preparation, d: Description): boolean =>
	Option.exists(
		p.resolution,
		(r) =>
			d.artifact === p.request.target.deployment?.artifact.identity.digest &&
			d.configuration === r.identity &&
			d.environment === r.environment &&
			d.protocol === 1 &&
			(p.request.target.deployment?.moduleKind !== undefined
				? d.members.length === 0
				: identified(p, d) &&
					Array.some(
						d.members,
						(member) => member.instance === p.request.instance,
					)),
	)
const finish = (s: Working, p: Preparation): Working => {
	if (!ended(s, p)) return s
	if (Option.isSome(p.result)) return release(save(s, p), p)
	if (Option.isSome(p.failure)) return reject(s, p, p.failure.value)
	if (Option.isNone(p.description) || Option.isNone(p.resolution))
		return reject(s, p, "DescriptionFailed")
	if (!authorized(s, p.request.instance, p.request.target))
		return reject(s, p, "Unauthorized")
	if (policy(s, p.request.instance).version !== p.policyVersion)
		return reject(s, p, "Stale")
	const cacheTarget = descriptionKey(p.request)
	const cacheHistory = Array.append(
		Array.filter(s.verifiedHistory, (t) => !Equal.equals(t, cacheTarget)),
		cacheTarget,
	)
	const cachedState: Working = {
		...s,
		verifiedHistory: Array.takeRight(cacheHistory, Math.max(1, s.historyLimit)),
		verified: HashMap.set(
			cacheHistory.length > s.historyLimit
				? Option.match(Array.head(cacheHistory), {
						onNone: () => s.verified,
						onSome: (t) => HashMap.remove(s.verified, t),
					})
				: s.verified,
			cacheTarget,
			{
				target: p.request.target,
				policyValues: policy(s, p.request.instance).values,
				resolution: p.resolution.value,
				description: p.description.value,
			},
		),
	}
	const inspected = HashMap.set(
		p.inspected,
		p.request.instance,
		p.description.value,
	)
	const inspectedResolutions = HashMap.set(
		p.inspectedResolutions,
		p.request.instance,
		p.resolution.value,
	)
	const nextRoot = Array.findFirst(
		p.request.operations ?? [],
		(operation) =>
			operation._tag === "Deploy" &&
			!HashMap.has(inspected, operation.instance),
	)
	if (Option.isSome(nextRoot) && nextRoot.value._tag === "Deploy")
		return continueInspection(
			cachedState,
			{ ...p, inspected, inspectedResolutions },
			{ ...p.request, ...nextRoot.value },
		)
	if (p.inspect || p.parent !== undefined)
		return result(cachedState, p, {
			_tag: "Described",
			description: p.description.value,
		})
	const first = Array.findFirst(
		p.request.operations ?? [],
		(operation) => operation._tag === "Deploy",
	)
	const focused =
		Option.isSome(first) && first.value._tag === "Deploy"
			? { ...p.request, ...first.value }
			: p.request
	const lastDescription = p.description.value
	const descriptions = Array.fromIterable(HashMap.values(inspected))
	const description = {
		...Option.getOrElse(Array.head(descriptions), () => lastDescription),
		members: Array.flatMap(descriptions, (description) => description.members),
	}
	const request: Request = {
		...focused,
		...Option.match(HashMap.get(inspectedResolutions, focused.instance), {
			onNone: () => ({}),
			onSome: (resolution) => ({ resolution }),
		}),
		submitted: p.submitted,
		preparation: p.id,
		policyVersion: policy(s, focused.instance).version,
		description,
		proposal: proposal(s, focused, description),
		strategy: p.request.strategy,
	}

	return {
		...release(cachedState, p),
		admissions: Array.append(s.admissions, { preparation: p.id, request }),
	}
}
export const admitResult = (s: Working, id: string): Working =>
	update(s, id, (s, p) => {
		switch (s.reply._tag) {
			case "Admitted":
				return {
					...result(s, p, { _tag: "Admitted", change: s.reply.change }),
					reply: { ...s.reply, preparation: id },
				}
			case "Rejected":
				return reject(
					s,
					{ ...p, cause: Cause.combine(p.cause, s.reply.cause ?? Cause.empty) },
					s.reply.reason,
					s.reply.conflicts,
				)
			default:
				return s
		}
	})
const inspectionUnit = (
	p: Preparation,
	request: Request,
	unitId: string,
	authority: string,
): Unit => ({
	memberBudget: request.budget,
	placement: request.boundary ??
		request.placement ?? { kind: request.target.placement },
	group: unitId,
	members: Executions.members(
		HashMap.make([request.instance, Grants.requested(request, 0, 0)]),
		"Declared",
	),
	memberHistory: HashMap.empty(),
	localConsumers: HashMap.empty(),
	children: HashMap.empty(),
	id: unitId,
	kind: "Inspection",
	description: Option.none(),
	incarnation: `${authority}/${unitId}`,
	owner: p.id,
	claim: p.claim,
	spawn: `${p.id}/spawn/${p.nextCommand}`,
	phase: "PendingSpawn",
	evidence: "Missing",
	cleanup: { _tag: "Unknown" },
	cause: Cause.empty,
	leases: HashSet.empty(),
})

const continueInspection = (
	s: Working,
	previous: Preparation,
	request: Request,
): Working => {
	const unitId = `${previous.id}@inspection/${previous.nextCommand}`
	const p: Preparation = {
		...previous,
		request,
		unit: unitId,
		inspectionUnits: HashSet.add(previous.inspectionUnits, unitId),
		phase: "Resolving",
		resolution: Option.none(),
		description: Option.none(),
		policyVersion: policy(s, request.instance).version,
	}
	const unit = inspectionUnit(p, request, unitId, s.authority)
	const allocated = save(
		{
			...disarm(s, previous, timerPurposes("Operation", "Evidence")),
			units: HashMap.set(s.units, unitId, unit),
			claims: HashMap.set(s.claims, p.claim, {
				id: p.claim,
				owner: p.id,
				unit: Option.some(unitId),
			}),
		},
		p,
	)
	const intended = emit(allocated, p, "Spawn", false, unit.spawn)
	return update(intended, p.id, (s, p) =>
		operation(s, p, "Resolve", "Resolving", request.budget.startup),
	)
}

export const start = (
	s: Working,
	request: Request,
	inspect: boolean,
	recovery?: {
		readonly parent: string
		readonly claim: string
		readonly resolution: ResolvedInput
		readonly submitted: number
	},
): Working => {
	const existing =
		request.key === undefined
			? Option.none<string>()
			: HashMap.get(s.preparationKeys, request.key)
	if (Option.isSome(existing))
		return update(s, existing.value, (s, p) =>
			Equal.equals(p.request.identity, request.identity) &&
			p.inspect === inspect
				? {
						...s,
						reply: Option.match(p.result, {
							onNone: () => ({ _tag: "Preparing", preparation: p.id }),
							onSome: (r) =>
								r._tag === "Admitted"
									? { _tag: "Admitted", change: r.change, preparation: p.id }
									: r._tag === "Rejected"
										? {
												_tag: "Rejected",
												reason: r.reason,
												conflicts: r.conflicts,
												preparation: p.id,
												cause: p.cause,
											}
										: { _tag: "Preparing", preparation: p.id },
						}),
					}
				: {
						...s,
						reply: {
							_tag: "Rejected",
							reason: "KeyConflict",
							conflicts: HashSet.empty(),
						},
					},
		)
	if (recovery === undefined && HashMap.size(s.claims) >= s.maxUnits)
		return {
			...s,
			reply: {
				_tag: "Rejected",
				reason: "Capacity",
				conflicts: HashSet.empty(),
			},
		}
	const id = `preparation-${s.nextPreparation}`
	const unitId = `${id}@inspection`
	const p: Preparation = {
		inspected: HashMap.empty(),
		inspectedResolutions: HashMap.empty(),
		inspectionUnits: HashSet.make(unitId),
		interrupted: Option.none(),
		claim: recovery?.claim ?? `${id}/capacity`,
		...(recovery === undefined ? {} : { parent: recovery.parent }),
		archived: false,
		id,
		request,
		inspect,
		unit: unitId,
		submitted: recovery?.submitted ?? s.now,
		deadline: (recovery?.submitted ?? s.now) + request.budget.total,
		policyVersion: policy(s, request.instance).version,
		phase: "Resolving",
		resolution: Option.fromNullishOr(recovery?.resolution),
		description: Option.none(),
		failure: Option.none(),
		cause: Cause.empty,
		result: Option.none(),
		sequence: 0,
		nextCommand: 1,
		commandIds: HashSet.empty(),
		timerIds: HashSet.empty(),
	}
	const unit = inspectionUnit(p, request, unitId, s.authority)
	const allocated = save(
		{
			...s,
			nextPreparation: s.nextPreparation + 1,
			units: HashMap.set(s.units, unitId, unit),
			claims: HashMap.set(s.claims, unit.claim, {
				id: unit.claim,
				owner: id,
				unit: Option.some(unitId),
			}),
			preparationKeys:
				request.key === undefined
					? s.preparationKeys
					: HashMap.set(s.preparationKeys, request.key, id),
		},
		p,
	)
	const attached: Working =
		recovery === undefined
			? allocated
			: {
					...allocated,
					changes: HashMap.modify(allocated.changes, recovery.parent, (c) => ({
						...c,
						units: HashSet.add(c.units, unitId),
						requiredExits: HashSet.add(c.requiredExits, unitId),
					})),
					changed: HashSet.add(allocated.changed, recovery.parent),
				}
	const intended = emit(attached, p, "Spawn", false, unit.spawn)
	const started =
		recovery === undefined
			? update(intended, id, (s, p) =>
					operation(s, p, "Resolve", "Resolving", request.budget.startup),
				)
			: update(intended, id, (s, p) =>
					activateSpawn(s, { ...p, phase: "Spawning" }, recovery.resolution),
				)
	return {
		...arm(started, id, "Total", p.deadline),
		reply: { _tag: "Preparing", preparation: id },
	}
}
const activateSpawn = (
	s: Working,
	p: Preparation,
	resolution: ResolvedInput,
): Working => {
	const unit = HashMap.get(s.units, p.unit)
	if (Option.isNone(unit))
		return fail(
			s,
			p,
			"DescriptionFailed",
			Cause.fail("Inspection intent is missing"),
		)
	const spawn = HashMap.get(s.commands, unit.value.spawn)
	if (Option.isNone(spawn))
		return fail(
			s,
			p,
			"DescriptionFailed",
			Cause.fail("Inspection spawn intent is missing"),
		)
	const command = {
		...spawn.value,
		dispatched: true,
		resolution: resolution,
	}
	const activated = save(
		{
			...s,
			commands: HashMap.set(s.commands, command.id, command),
			emitted: Array.append(s.emitted, command),
		},
		p,
	)
	return arm(
		disarm(activated, p, timerPurposes("Operation")),
		p.id,
		"Operation",
		s.now + p.request.budget.startup,
	)
}
const failedReport = (
	s: Working,
	p: Preparation,
	c: Command,
	result: Extract<Report, { _tag: "Failed" }>,
): Working => {
	const confirmed =
		c.kind === "Spawn" && result.creation === "NotStarted"
			? {
					...s,
					units: HashMap.modify(s.units, p.unit, (u): Unit => ({
						...u,
						phase: "NotStarted",
						evidence: "NotStarted",
					})),
				}
			: s
	return fail(confirmed, p, result.reason ?? "DescriptionFailed", result.cause)
}
const describedReport = (
	s: Working,
	p: Preparation,
	value: Description,
): Working => {
	if (!valid(p, value))
		return fail(
			s,
			p,
			"Unsupported",
			Cause.fail("Inspection declarations do not match the fixed deployment"),
		)
	const next = { ...p, description: Option.some(value) }
	return operation(
		save(s, next),
		next,
		"Stop",
		"Stopping",
		p.request.budget.stop,
	)
}
const spawnedReport = (s: Working, p: Preparation): Working =>
	p.phase !== "Spawning"
		? s
		: operation(
				{
					...s,
					units: HashMap.modify(s.units, p.unit, (u) => ({
						...u,
						phase: "Running",
					})),
				},
				p,
				"Describe",
				"Describing",
				p.request.budget.startup,
			)
const successfulReport = (
	s: Working,
	p: Preparation,
	c: Command,
	result: Report,
): Working => {
	if (Option.isSome(p.result)) return s
	switch (c.kind) {
		case "Resolve":
			return p.phase === "Resolving" && result._tag === "Resolved"
				? activateSpawn(
						s,
						{ ...p, phase: "Spawning", resolution: Option.some(result.value) },
						result.value,
					)
				: s
		case "Spawn":
			return spawnedReport(s, p)
		case "Describe":
			return p.phase === "Describing" && result._tag === "Described"
				? describedReport(s, p, result.value)
				: s
		default:
			return s
	}
}
export const reported = (
	s: Working,
	event: Extract<Event, { _tag: "Reported" }>,
): Working =>
	Option.match(HashMap.get(s.commands, event.command), {
		onNone: () => s,
		onSome: (c) =>
			update(s, c.change, (s, p) => {
				if (
					!c.dispatched ||
					c.disposition !== "Pending" ||
					!Equal.equals(c.token, event.token)
				)
					return s
				const recorded: Working = {
					...s,
					commands: HashMap.set(s.commands, c.id, {
						...c,
						disposition: "Reported",
						report: Option.some(event.result),
					}),
				}
				return event.result._tag === "Failed"
					? failedReport(recorded, p, c, event.result)
					: successfulReport(recorded, p, c, event.result)
			}),
	})
export const nativeFailure = (
	s: Working,
	event: Extract<Event, { _tag: "UnitFailed" | "UnitDisconnected" }>,
): Working =>
	Option.match(HashMap.get(s.units, event.unit), {
		onNone: () => s,
		onSome: (u) =>
			update(s, u.owner, (s, p) => {
				if (u.incarnation !== event.incarnation || u.spawn !== event.observer)
					return s
				const cause = Cause.combine(p.cause, event.cause)
				const recorded: Working = {
					...s,
					units: HashMap.set(s.units, u.id, {
						...u,
						cause: Cause.combine(u.cause, event.cause),
					}),
				}
				return event._tag === "UnitDisconnected" &&
					(u.evidence !== "Missing" ||
						u.id !== p.unit ||
						p.phase === "Stopping" ||
						p.phase === "Terminating" ||
						Option.isSome(p.result))
					? save(recorded, { ...p, cause })
					: fail(recorded, p, "DescriptionFailed", event.cause)
			}),
	})
export const exited = (
	s: Working,
	event: Extract<Event, { _tag: "Exited" }>,
): Working =>
	Option.match(HashMap.get(s.units, event.unit), {
		onNone: () => s,
		onSome: (u) =>
			update(s, u.owner, (s, p) => {
				if (
					u.evidence !== "Missing" ||
					u.incarnation !== event.incarnation ||
					u.spawn !== event.observer
				)
					return s
				const cleanup =
					event.cleanup._tag === "Unknown" ? u.cleanup : event.cleanup
				const unit: Unit = {
					...u,
					evidence: "Exited",
					phase: "Exited",
					cleanup,
					cause: Cause.combine(u.cause, event.cause),
					leases: HashSet.empty(),
				}
				const failed = cleanup._tag === "Failed"
				const next: Preparation = {
					...p,
					cause: Cause.combine(
						p.cause,
						failed
							? Cause.combine(
									event.cause,
									cleanup._tag === "Failed" ? cleanup.cause : Cause.empty,
								)
							: event.cause,
					),
					failure: failed
						? Option.some<Rejection>("DescriptionFailed")
						: p.failure,
				}
				return finish(
					save({ ...s, units: HashMap.set(s.units, u.id, unit) }, next),
					next,
				)
			}),
	})
export const timer = (
	s: Working,
	event: Extract<Event, { _tag: "TimerFired" }>,
): Working =>
	Option.match(HashMap.get(s.timers, event.timer), {
		onNone: () => s,
		onSome: (t) =>
			update(s, t.change, (s, p) => {
				if (
					!t.active ||
					t.generation !== event.generation ||
					event.now < t.deadline ||
					Option.isSome(p.result)
				)
					return s
				const fired = {
					...s,
					timers: HashMap.set(s.timers, t.id, { ...t, active: false }),
				}
				if (t.purpose === "Evidence")
					return reject(
						fired,
						{
							...p,
							cause: Cause.combine(
								p.cause,
								Cause.fail("Inspection exit evidence is missing"),
							),
						},
						"DescriptionFailed",
					)
				return fail(
					fired,
					p,
					"DescriptionFailed",
					Cause.fail(`Inspection ${t.purpose} deadline expired`),
				)
			}),
	})
export const observed = (s: Working, id: string): Working => update(s, id, save)
export const timerEnded = (
	s: Working,
	event: Extract<Event, { _tag: "TimerEnded" }>,
): Working =>
	Option.match(HashMap.get(s.timers, event.timer), {
		onNone: () => s,
		onSome: (t) =>
			update(s, t.change, (s, p) => {
				if (!t.active || t.generation !== event.generation) return s
				const next = {
					...s,
					timers: HashMap.set(s.timers, t.id, {
						...t,
						active: false,
						cause: Cause.combine(t.cause, event.cause),
					}),
				}
				return t.purpose === "Evidence"
					? reject(
							next,
							{ ...p, cause: Cause.combine(p.cause, event.cause) },
							"DescriptionFailed",
						)
					: fail(next, p, "DescriptionFailed", event.cause)
			}),
	})
export const expire = (s: Working, id: string): Working =>
	update(s, id, (s, p) => {
		const due = Array.sort(
			Array.flatMap(Array.fromIterable(p.timerIds), (id) =>
				Option.toArray(
					Option.filter(
						HashMap.get(s.timers, id),
						(t) => t.active && t.deadline < s.now,
					),
				),
			),
			(a: Timer, b: Timer) =>
				a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0,
		)
		return Array.reduce(due, s, (s, t) =>
			timer(s, {
				_tag: "TimerFired",
				timer: t.id,
				generation: t.generation,
				now: s.now,
			}),
		)
	})
export const cancelTimers = (before: State, s: Working): Working =>
	HashSet.reduce(s.preparationsChanged, s, (s, id) =>
		update(s, id, (s, p) =>
			HashSet.reduce(p.timerIds, s, (s, timer) =>
				Option.exists(HashMap.get(before.timers, timer), (t) => t.active) &&
				Option.exists(HashMap.get(s.timers, timer), (t) => !t.active)
					? emit(s, p, "CancelTimer", true, undefined, Option.some(timer))
					: s,
			),
		),
	)
export const publish = (before: State, s: Working): Working =>
	HashSet.reduce(s.preparationsChanged, s, (s, id) =>
		update(s, id, (s, p) => {
			const previous = get(before, id)
			if (Option.isSome(previous) && Equal.equals(previous, get(s, id)))
				return s
			const revised = { ...p, sequence: p.sequence + 1 }
			const next = save(s, revised)
			return issue(next, id, "PublishPreparation")
		}),
	)
export const shutdown = (s: Working): Working =>
	HashMap.reduce(s.preparations, s, (s, p) =>
		Option.isSome(p.result)
			? s
			: fail(s, p, "Closing", Cause.fail("Runtime shutdown during inspection")),
	)
