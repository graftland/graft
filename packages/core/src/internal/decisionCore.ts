import {
	Array as Arr,
	Cause,
	Equal,
	HashMap,
	HashSet,
	Number as Num,
	Option,
	Result,
} from "effect"

import * as Bindings from "./bindingCore"
import * as Calls from "./callCore"
import * as InputSnapshot from "./decisionInput"
import type {
	Budget,
	CallLimits,
	Cell,
	Change,
	Claim,
	Command,
	CommandKind,
	Conclusion,
	DeploymentOperation,
	Description,
	Event,
	FixedBinding,
	GroupPlan,
	Input,
	InspectionInput,
	Instance,
	MemberDeclaration,
	MemberExecution,
	MemberFact,
	Outcome,
	PendingRestart,
	Phase,
	RealmDeclaration,
	RecordFact,
	RecordingDeclaration,
	RecordStage,
	Rejection,
	Request,
	RequestIdentity,
	ResolvedInput,
	SelectionReason,
	Settlement,
	State,
	Status,
	SupervisionDeclaration,
	Target,
	Timer,
	TimerPurpose,
	Transition,
	Unit,
	UnitMember,
	Working,
} from "./decisionState.ts"
import { deploymentIdentity } from "./deploymentIdentity"
import * as Executions from "./executionState"
import * as Attempt from "./groupAttempt"
import * as Graph from "./groupGraph"
import * as Members from "./memberCore"
import * as Grants from "./memberGrant"
import * as Preparation from "./preparationCore"
import * as Recording from "./recordingCore"
import * as Supervisor from "./supervisorCore"

export const getPreparation = Preparation.get
export const supervision = Supervisor.facts
export type * from "./decisionState.ts"

const emptyCell: Cell = {
	version: 0,
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
	if (HashSet.size(Calls.outstanding(s, c.requiredExits)) > 0)
		return "Unresolved"
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

const member = (s: State, c: Change, id: string): MemberFact => {
	const instance = HashMap.get(s.instances, id)
	const current = Option.flatMap(instance, (member) =>
		Option.flatMap(member.current, (key) => HashMap.get(s.units, key)),
	)
	const execution = Option.flatMap(current, (unit) =>
		HashMap.get(unit.members, id),
	)
	const healthy = Executions.healthy(s, id)
	const desired = Option.map(
		HashMap.get(c.plan.desired, id),
		(member) => member.target,
	)
	const attempted = Arr.findFirst(Arr.fromIterable(Attempt.units(c)), (unit) =>
		Option.isSome(
			Option.flatMap(HashMap.get(s.units, unit), (u) =>
				Option.orElse(HashMap.get(u.members, id), () =>
					HashMap.get(u.memberHistory, id),
				),
			),
		),
	)
	const phase = Option.flatMap(attempted, (unit) =>
		Option.flatMap(HashMap.get(s.units, unit), (u) =>
			Option.map(
				Option.orElse(HashMap.get(u.members, id), () =>
					HashMap.get(u.memberHistory, id),
				),
				(m) => m.phase,
			),
		),
	)
	return {
		instance: id,
		startingHealthy: Option.getOrElse(
			HashMap.get(c.startingHealth, id),
			() => false,
		),
		attempt: Option.match(phase, {
			onNone: () => "NotStarted" as const,
			onSome: (p) =>
				p === "Ready"
					? "Ready"
					: p === "Failed"
						? "Failed"
						: p === "Stopping" || p === "Stopped"
							? "Stopped"
							: p === "NotStarted"
								? "NotStarted"
								: "Started",
		}),
		reasons: Option.getOrElse(
			HashMap.get(c.plan.reasons, id),
			HashSet.empty<SelectionReason>,
		),
		starting: Option.map(
			HashMap.get(c.plan.previous, id),
			(member) => member.target,
		),
		startingVersion: Option.getOrElse(
			HashMap.get(c.startingVersions, id),
			() => 0,
		),
		desired,
		actual: Option.map(execution, (member) => member.target),
		healthy,
		matchesTarget: Option.match(desired, {
			onNone: () => Option.isNone(current),
			onSome: (target) =>
				healthy &&
				Option.exists(execution, (member) =>
					Equal.equals(member.target, target),
				) &&
				Option.exists(current, (unit) =>
					Option.exists(
						Arr.findFirst(HashMap.values(c.plan.newGroups), (group) =>
							HashSet.has(group.members, id),
						),
						(group) => group.id === unit.group,
					),
				),
		}),
	}
}
const members = (s: State, c: Change): HashMap.HashMap<string, MemberFact> =>
	HashMap.fromIterable(
		Arr.map(Arr.fromIterable(c.plan.members), (id) => [id, member(s, c, id)]),
	)
/** Member facts in instance order, as a durable record keeps them. */
const recordFacts = (
	facts: HashMap.HashMap<string, MemberFact>,
): ReadonlyArray<RecordFact> =>
	Arr.map(
		Arr.sort(
			Arr.fromIterable(HashMap.keys(facts)),
			(a: string, b: string): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0),
		),
		(id) => {
			const fact = Option.getOrThrow(HashMap.get(facts, id))
			return {
				instance: fact.instance,
				desired: Option.map(fact.desired, (t) => t.identity),
				actual: Option.map(fact.actual, (t) => t.identity),
				healthy: fact.healthy,
				attempt: fact.attempt,
			}
		},
	)

export const get = (s: State, id: string): Option.Option<Status> =>
	Option.map(HashMap.get(s.changes, id), (c) => ({
		id,
		completion: c.request.completion ?? "Serving",
		origin: Option.fromUndefinedOr(c.request.origin),
		plan: c.plan,
		outstandingCalls: Calls.outstanding(s, c.requiredExits),
		sequence: c.sequence,
		phase: c.phase,
		oldChanged: c.oldChanged,
		recovering: c.recovering,
		members: members(s, c),
		remaining: Num.max(0, c.deadline - s.now),
		leaseHolders: HashSet.filter(c.units, (id) =>
			Option.exists(
				HashMap.get(s.units, id),
				(u) => u.owner === c.id && HashSet.size(u.leases) > 0,
			),
		),
		unconfirmedUnits: HashSet.filter(c.requiredExits, (id) => live(s, id)),
		settlement: classify(s, c),
		recording: Recording.status(s, c),
		cause: c.cause,
		conclusion: c.conclusion,
	}))

export const make = (options: {
	readonly declarations: ReadonlyArray<MemberDeclaration>
	readonly realms: ReadonlyArray<RealmDeclaration>
	readonly authority: string
	/** Unique per kernel start; tests may leave it out. */
	readonly run?: string
	readonly maxUnits: number
	readonly callLimits?: Partial<CallLimits>
	readonly bindings?: ReadonlyArray<FixedBinding>
	readonly recording?: RecordingDeclaration
	readonly supervision?: SupervisionDeclaration
}): State => {
	const graph = Graph.initialize(options.declarations, options.realms)
	return Arr.reduce(
		Arr.fromIterable(
			HashMap.values(
				Result.match(graph, {
					onSuccess: (g) => g.groups,
					onFailure: () => Graph.empty().groups,
				}),
			),
		),
		{
			recording: Option.map(
				Option.fromUndefinedOr(options.recording),
				Recording.policy,
			),
			recorder: Option.none(),
			records: HashMap.empty(),
			recordsOutstanding: 0,
			recordsPromised: 0,
			priorKeys: HashMap.empty(),
			recovered: false,
			supervisionPolicy: Supervisor.policy(options.supervision),
			supervision: HashMap.empty(),
			pendingRestarts: HashMap.empty(),
			restartBackoffs: HashMap.empty(),
			nextRestartTimer: 1,
			nextMemberOperation: 1,
			memberOperations: HashMap.empty(),
			memberOperationsByUnit: HashMap.empty(),
			graph: Result.match(graph, {
				onSuccess: (value) => value,
				onFailure: Graph.empty,
			}),
			graphIssue: Result.match(graph, {
				onSuccess: () => Option.none(),
				onFailure: Option.some,
			}),
			...Bindings.index(options.bindings ?? []),
			...Calls.initial(),
			callLimits: { ...Calls.initial().callLimits, ...options.callLimits },
			routes: HashMap.empty(),
			authority: options.authority,
			run: options.run ?? "",
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
		} satisfies State,
		(s: State, group): State => {
			const hosted = HashMap.fromIterable(
				Arr.flatMap(Arr.fromIterable(group.members), (id) =>
					Option.toArray(
						Option.map(
							HashMap.get(s.graph.declarations, id),
							(m) =>
								[
									id,
									{
										...Grants.declared(
											m,
											0,
											0,
											Option.getOrElse(
												HashMap.get(s.graph.dependencies, id),
												() => [],
											),
										),
										dependencies: Option.getOrElse(
											HashMap.get(s.graph.dependencies, id),
											() => [],
										),
									},
								] satisfies readonly [string, UnitMember],
						),
					),
				),
			)
			const first = Arr.head(Arr.fromIterable(HashMap.values(hosted)))
			if (Option.isNone(first)) return s
			const entry = first.value
			const id = `${entry.instance}@0`
			const unit: Unit = {
				memberBudget: defaultBudget,
				placement: group.placement,
				kind: "Execution",
				description: Option.none(),
				id,
				incarnation: `${options.authority}/${id}`,
				group: group.id,
				members: Executions.members(hosted, "Ready"),
				memberHistory: HashMap.empty(),
				...Executions.indexes(Executions.members(hosted, "Ready")),
				owner: `group:${group.id}`,
				claim: id,
				spawn: `${id}/initial`,
				phase: "Running",
				evidence: "Missing",
				cleanup: { _tag: "Unknown" },
				cause: Cause.empty,
				leases: HashSet.empty(),
			}
			const initialized = HashMap.reduce(hosted, s, (out, member) => ({
				...out,
				instances: HashMap.set(out.instances, member.instance, {
					id: member.instance,
					established: true,
					current: Option.some(id),
					term: 0,
				}),
				cells: HashMap.set(
					HashMap.set(out.cells, member.instance, {
						...emptyCell,
						version: 1,
					}),
					Graph.memberSlot(member.instance),
					{ ...emptyCell, version: 1 },
				),
			}))
			return {
				...initialized,
				cells: HashMap.set(initialized.cells, Graph.membership(group.id), {
					...emptyCell,
					version: group.version,
				}),
				units: HashMap.set(initialized.units, id, unit),
				claims: HashMap.set(initialized.claims, id, {
					id,
					owner: `group:${group.id}`,
					unit: Option.some(id),
				}),
			}
		},
	)
}

const participantView = (
	s: State,
	c: Change,
	unit: Option.Option<Unit>,
	active: boolean,
) => ({
	routes: Arr.filter(
		(active ? Bindings.activeView(s, c) : Bindings.view(s, c)).routes,
		(r) => Option.exists(unit, (u) => HashMap.has(u.members, r.consumer)),
	),
})
const emit = (
	s: Working,
	c: Change,
	kind: CommandKind,
	unit = "",
	participant = "",
	timer: Option.Option<string> = Option.none(),
): Working => {
	const u = HashMap.get(s.units, unit)
	const focused = Attempt.current(c)
	const hosted = Option.match(u, {
		onSome: (unit) => Executions.grants(unit.members),
		onNone: () =>
			HashMap.fromIterable(
				Arr.flatMap(Arr.fromIterable(Attempt.currentMembers(c)), (id) =>
					Option.toArray(
						Option.map(
							HashMap.get(Attempt.declarations(c), id),
							(m) =>
								[
									id,
									Grants.declared(
										m,
										0,
										0,
										Option.getOrElse(
											HashMap.get(
												c.recovering
													? c.plan.previousDependencies
													: c.plan.dependencies,
												id,
											),
											() => [],
										),
									),
								] satisfies readonly [string, UnitMember],
						),
					),
				),
			),
	})
	const selected = HashSet.fromIterable(HashMap.keys(hosted))
	const selectMap = <A>(
		map: HashMap.HashMap<string, A>,
	): HashMap.HashMap<string, A> =>
		HashSet.reduce(selected, HashMap.empty<string, A>(), (out, id) =>
			Option.match(HashMap.get(map, id), {
				onNone: () => out,
				onSome: (value) => HashMap.set(out, id, value),
			}),
		)
	const wave = Arr.get(
		c.recovering ? c.plan.recoveryWaves : c.plan.startWaves,
		c.serveWave,
	)
	const command: Command = {
		subjects:
			kind === "Serve"
				? Option.match(wave, {
						onNone: HashSet.empty<string>,
						onSome: (wave) => HashSet.intersection(wave, selected),
					})
				: selected,
		placement: Option.getOrElse(
			Option.map(u, (unit) => unit.placement).pipe(
				Option.orElse(() =>
					Option.flatMap(c.currentGroup, (id) =>
						HashMap.get(Attempt.groups(c), id),
					).pipe(Option.map((group) => group.placement)),
				),
			),
			() => ({ kind: c.request.target.placement }),
		),
		resolutions: selectMap(c.resolutions),
		descriptions: selectMap(c.descriptions),
		policies: HashMap.fromIterable(
			Arr.map(Arr.fromIterable(selected), (id) => [
				id,
				Preparation.policy(s, id),
			]),
		),
		members: hosted,
		dispatched: true,
		id: `${c.id}/${c.nextCommand}`,
		change: c.id,
		kind,
		unit,
		participant,
		timer,
		target: Option.getOrElse(
			Option.flatMap(u, (u) =>
				Option.map(
					Arr.head(Arr.fromIterable(HashMap.values(u.members))),
					(member) => member.target,
				),
			),
			() =>
				Option.getOrElse(
					Option.map(focused, (m) => m.target),
					() => c.request.target,
				),
		),
		...(kind === "Activate"
			? { view: participantView(s, c, u, true) }
			: kind === "Install" || kind === "Serve"
				? { view: participantView(s, c, u, false) }
				: {}),
		policy: Preparation.policy(
			s,
			Option.getOrElse(c.currentMember, () => c.request.instance),
		),
		...Option.match(Attempt.resolution(c), {
			onNone: () => ({}),
			onSome: (resolution) => ({ resolution }),
		}),
		...Option.match(
			Option.flatMap(u, (unit) => unit.description).pipe(
				Option.orElse(() => Attempt.description(c)),
			),
			{ onNone: () => ({}), onSome: (description) => ({ description }) },
		),
		probes: c.request.probes ?? [],
		token: {
			authority: s.authority,
			change: c.id,
			unit,
			incarnation: Option.match(u, {
				onNone: () => "",
				onSome: (u) => u.incarnation,
			}),
			members: Executions.tokens(hosted),
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
	HashSet.size(c.invalidated) === 0 &&
	HashMap.every(c.plan.previous, (_, id) =>
		Option.exists(
			HashMap.get(s.instances, id),
			(member) =>
				Executions.healthy(s, id) &&
				Option.exists(member.current, (unit) => live(s, unit)),
		),
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
						(u.owner === `group:${u.group}` &&
							!HashMap.some(u.members, (member) =>
								Option.exists(
									HashMap.get(s.instances, member.instance),
									(instance) => Option.contains(instance.current, u.id),
								),
							))),
			)
				? HashMap.remove(units, unit)
				: units,
		),
		observers: HashSet.reduce(keys(c.request), s.observers, (observers, key) =>
			HashMap.modify(observers, key, (ids) => HashSet.remove(ids, id)),
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
						  HashSet.has(transferred, claim.unit.value)
						? HashMap.set(claims, id, {
								...claim,
								owner: Option.getOrElse(
									Option.map(
										HashMap.get(s.units, claim.unit.value),
										(u) => `group:${u.group}`,
									),
									() => claim.owner,
								),
							})
						: Option.isNone(claim.unit)
							? HashMap.remove(claims, id)
							: claims,
		}),
	)
	const units = HashSet.reduce(c.units, released.units, (units, id) =>
		HashMap.modify(units, id, (u) =>
			HashSet.has(transferred, id) ? { ...u, owner: `group:${u.group}` } : u,
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
	HashSet.reduce(c.transferred, s, (s, id) =>
		withUnit(s, id, (s, u) =>
			u.owner !== c.id
				? s
				: {
						...s,
						units: HashMap.set(s.units, id, {
							...u,
							owner: `group:${u.group}`,
						}),
						claims: HashMap.modify(s.claims, u.claim, (claim) =>
							claim.owner === c.id
								? { ...claim, owner: `group:${u.group}` }
								: claim,
						),
					},
		),
	)
const conclude = (s: Working, c: Change, outcome: Outcome): Working => {
	if (Option.isSome(c.conclusion)) return release(s, c)
	const classification = classify(s, c)
	if (classification === "Unresolved" && outcome !== "Stuck") return s
	if (classification === "Failed" && outcome === "Accepted")
		return fail(s, c, Cause.fail("Required retirement cleanup failed"))
	if (
		outcome === "Accepted" &&
		c.recorded &&
		!Recording.acknowledged(s, c.id, "Conclusion")
	)
		return Option.contains(c.recordingGate, "Conclusion")
			? s
			: gate(
					disarm(s, c, HashSet.make("Operation", "Trial", "Total", "Evidence")),
					{ ...c, executed: Option.some(members(s, c)) },
					"Conclusion",
					Option.some(outcome),
				)
	const conclusion: Conclusion = {
		plan: c.plan,
		calls: Calls.outstanding(s, c.requiredExits),
		outcome,
		phase: Option.getOrElse(c.interrupted, () => c.phase),
		cause: c.cause,
		members: Option.getOrElse(c.executed, () => members(s, c)),
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
				? Attempt.units(c)
				: availableOld(s, c)
					? c.oldUnits
					: HashSet.empty(),
	}
	const established: Working =
		outcome === "Accepted" ||
		outcome === "Recovered" ||
		(!c.failure && c.trialPassed)
			? {
					...s,
					instances: HashSet.reduce(c.plan.members, s.instances, (index, id) =>
						HashMap.modify(index, id, (i) => ({
							...i,
							established: HashMap.has(Attempt.declarations(c), id),
						})),
					),
				}
			: s

	const saved = save(
		obsolete(
			disarm(
				established,
				c,
				HashSet.make("Operation", "Trial", "Total", "Evidence"),
			),
			c,
		),
		next,
	)
	const recorded =
		c.recorded && outcome !== "Accepted"
			? Recording.request(
					saved,
					next,
					"Conclusion",
					Option.some(outcome),
					recordFacts(conclusion.members),
				)
			: saved
	const supervised =
		outcome === "Accepted"
			? Supervisor.cleared(
					Recording.settled(recorded, c),
					c.plan.members,
					c.request.supervised === undefined,
				)
			: Recording.settled(recorded, c)
	return release(transferServing(supervised, next), next)
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
const resolve = (s: Working, c: Change): Working => {
	const group = Attempt.nextGroup(c)
	if (Option.isNone(group))
		return serveWave(s, {
			...c,
			currentGroup: Option.none(),
			currentMember: Option.none(),
		})
	const member = Arr.findFirst(
		group.value.members,
		(id) => !HashSet.has(c.resolvedMembers, id),
	)
	const next: Change = {
		...c,
		currentGroup: Option.some(group.value.id),
		currentMember: Option.orElse(member, () =>
			Arr.head(Arr.fromIterable(group.value.members)),
		),
	}
	const saved = save(s, next)
	return Option.isNone(member)
		? spawn(saved, next)
		: operation(
				saved,
				next,
				"Resolve",
				"Resolving",
				"",
				c.request.budget.startup,
			)
}
const collective = (
	s: Working,
	c: Change,
	kind: "Ready" | "Probe",
	targetPhase: Phase,
	duration: number,
): Working => {
	const units = Attempt.units(c)
	const next: Change = { ...c, phase: targetPhase, pendingUnits: units }
	const issued = HashSet.reduce(
		units,
		save(disarm(s, c, HashSet.make("Operation")), next),
		(s, unit) => issue(s, c.id, kind, unit),
	)
	return HashSet.size(units) === 0
		? install(issued, next)
		: arm(
				issued,
				c.id,
				"Operation",
				Num.min(s.now + duration, c.deadline - c.request.budget.terminate),
			)
}
const serveWave = (s: Working, c: Change): Working => {
	const wave = Arr.get(
		c.recovering ? c.plan.recoveryWaves : c.plan.startWaves,
		c.serveWave,
	)
	if (Option.isNone(wave))
		return collective(s, c, "Ready", "Readiness", c.request.budget.startup)
	const units = HashSet.fromIterable(
		Arr.flatMap(Arr.fromIterable(wave.value), (id) =>
			Option.toArray(Option.map(Attempt.unitFor(s, c, id), (unit) => unit.id)),
		),
	)
	const next: Change = {
		...c,
		phase: "Serving" satisfies Phase,
		pendingUnits: units,
	}
	const issued = HashSet.reduce(
		units,
		save(disarm(s, c, HashSet.make("Operation")), next),
		(s, unit) => issue(s, c.id, "Serve", unit),
	)
	return HashSet.size(units) === 0
		? serveWave(issued, { ...next, serveWave: next.serveWave + 1 })
		: arm(
				issued,
				c.id,
				"Operation",
				Num.min(
					s.now + c.request.budget.startup,
					c.deadline - c.request.budget.terminate,
				),
			)
}
const progressSettlement = (s: Working, c: Change): Working => {
	if (Option.isSome(c.conclusion)) return release(s, c)
	if (
		c.phase === "Draining" &&
		!HashSet.some(
			c.oldUnits,
			(id) => live(s, id) && Calls.providerOutstanding(s, id),
		)
	)
		return settled(s, c.oldUnits)
			? progressSettlement(
					save(s, { ...c, phase: "Retiring" satisfies Phase }),
					{
						...c,
						phase: "Retiring",
					},
				)
			: dispatchStops(s, c)

	if (
		!settled(s, c.requiredExits) ||
		HashSet.size(Calls.outstanding(s, c.requiredExits)) > 0
	)
		return s
	if (!c.failure) {
		if (c.phase === "Retiring" && c.trialPassed)
			return conclude(s, c, c.recovering ? "Recovered" : "Accepted")
		if (c.phase === "Retiring") return resolve(s, c)
		return s
	}
	if (c.shuttingDown || !c.hadServing) return conclude(s, c, "RecoveryFailed")
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
		invalidated: HashSet.empty(),
		candidates: HashMap.empty(),
		currentGroup: Option.none(),
		currentMember: Option.none(),
		loadedGroups: HashSet.empty(),
		resolvedMembers: HashSet.empty(),
		resolutions: HashMap.empty(),
		descriptions: HashMap.empty(),
		serveWave: 0,
		pendingUnits: HashSet.empty(),
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
	/** Execution already finished; only the success record is missing, so nothing may be undone. */
	if (Option.contains(c.recordingGate, "Conclusion"))
		return save(s, { ...c, cause: Cause.combine(c.cause, cause) })
	const required = HashSet.union(
		c.requiredExits,
		c.shuttingDown || c.oldChanged || !availableOld(s, c)
			? c.units
			: Attempt.units(c),
	)

	const failed: Change = {
		...c,
		phase: "Settling",
		interrupted: Option.orElse(c.interrupted, () => Option.some(c.phase)),
		failure: true,
		requiredExits: required,
		oldChanged:
			c.oldChanged ||
			HashSet.some(c.oldUnits, (id) => HashSet.has(required, id)),
		cause: Cause.combine(c.cause, cause),
		recoveryFailed: c.recoveryFailed || c.recovering,
	}
	const saved = save(
		c.failure
			? s
			: disarm(s, c, HashSet.make("Operation", "Trial", "Evidence")),
		failed,
	)
	const discarded = c.failure
		? saved
		: HashSet.reduce(c.requiredParticipants, saved, (s, participant) =>
				issue(s, c.id, "Discard", participant, participant),
			)
	const stopped = terminate(discarded, failed, required)
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
const dispatchStops = (s: Working, c: Change): Working => {
	const draining = HashSet.some(
		c.oldUnits,
		(id) => live(s, id) && Calls.providerOutstanding(s, id),
	)
	const staged: Change = { ...c, phase: draining ? "Draining" : "Retiring" }
	const pending = HashSet.filter(
		c.oldUnits,
		(id) => live(s, id) && !Calls.providerOutstanding(s, id),
	)
	const sent = HashSet.reduce(pending, save(s, staged), (s, id) =>
		issue(s, c.id, "Stop", id),
	)
	return arm(
		sent,
		c.id,
		"Operation",
		Num.min(
			s.now + (draining ? c.request.budget.drain : c.request.budget.stop),
			c.deadline - c.request.budget.terminate,
		),
	)
}
const stopOld = (s: Working, c: Change): Working => {
	const stopping: Change = {
		...c,
		oldChanged: true,
		phase: "Retiring",
		requiredExits: HashSet.union(c.requiredExits, c.oldUnits),
	}
	const unavailable: Working = {
		...s,
		units: HashSet.reduce(c.oldUnits, s.units, (index, id) =>
			HashMap.modify(index, id, (unit) =>
				Executions.update(
					unit,
					HashSet.fromIterable(HashMap.keys(unit.members)),
					"Stopping",
				),
			),
		),
	}
	const saved = save(unavailable, stopping)
	return settled(saved, c.oldUnits)
		? progressSettlement(saved, stopping)
		: dispatchStops(saved, stopping)
}
const spawn = (s: Working, c: Change): Working => {
	const free = Arr.findFirst(c.claims, (id) =>
		Option.exists(
			HashMap.get(s.claims, id),
			(claim) => claim.owner === c.id && Option.isNone(claim.unit),
		),
	)
	const group = Option.flatMap(c.currentGroup, (id) =>
		HashMap.get(Attempt.groups(c), id),
	)
	if (Option.isNone(free) || Option.isNone(group))
		return fail(
			s,
			c,
			Cause.fail("Reserved group execution capacity is unavailable"),
		)
	const hosted = HashMap.fromIterable(
		Arr.flatMap(Arr.fromIterable(group.value.members), (id) =>
			Option.toArray(
				Option.map(
					HashMap.get(Attempt.declarations(c), id),
					(member) =>
						[
							id,
							Grants.declared(
								member,
								Option.getOrElse(
									Option.map(HashMap.get(s.instances, id), (i) => i.term),
									() => 0,
								) + 1,
								Option.getOrElse(
									Option.map(HashMap.get(s.instances, id), (i) => i.term),
									() => 0,
								) + 1,
								Option.getOrElse(
									HashMap.get(
										c.recovering
											? c.plan.previousDependencies
											: c.plan.dependencies,
										id,
									),
									() => [],
								),
							),
						] satisfies readonly [string, UnitMember],
				),
			),
		),
	)

	const first = Arr.head(Arr.fromIterable(HashMap.values(hosted)))
	if (Option.isNone(first))
		return fail(s, c, Cause.fail("A deployment group has no admitted members"))
	const id = `${first.value.instance}@${first.value.term}`
	const expected = Option.map(Attempt.description(c), (description) => ({
		...description,
		members: Arr.flatMap(Arr.fromIterable(group.value.members), (id) =>
			Option.toArray(HashMap.get(Attempt.declarations(c), id)),
		),
	}))

	const unit: Unit = {
		memberBudget: c.request.budget,
		placement: group.value.placement,
		group: group.value.id,
		members: Executions.members(hosted, "Preparing"),
		memberHistory: HashMap.empty(),
		...Executions.indexes(Executions.members(hosted, "Preparing")),
		kind: "Execution",
		description: expected,
		id,
		incarnation: `${s.authority}/${id}`,
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
			instances: HashMap.reduce(hosted, s.instances, (index, grant) =>
				HashMap.modify(index, grant.instance, (member) => ({
					...member,
					term: grant.term,
				})),
			),
			units: HashMap.set(s.units, id, unit),
			claims: HashMap.modify(s.claims, free.value, (claim) => ({
				...claim,
				unit: Option.some(id),
			})),
		},
		{
			...c,
			candidates: HashMap.set(c.candidates, group.value.id, id),
			units: HashSet.add(c.units, id),
		},
	)
	return withChange(next, c.id, (s, c) =>
		operation(s, c, "Spawn", "Spawning", id, c.request.budget.startup),
	)
}
const install = (s: Working, c: Change): Working => {
	const required = HashSet.union(c.request.participants, Attempt.units(c))
	const staged: Change = {
		...c,
		phase: "Installing" satisfies Phase,
		requiredParticipants: required,
		installed: HashSet.empty<string>(),
	}
	const saved = save(disarm(s, c, HashSet.make("Operation")), staged)
	if (HashSet.size(required) === 0) return commitRecorded(saved, staged)
	const installed = HashSet.reduce(required, saved, (s, participant) =>
		issue(s, c.id, "Install", participant, participant),
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
				u.owner === `group:${u.group}` &&
				!HashMap.has(s.commands, u.spawn)
					? { ...s, units: HashMap.remove(s.units, u.id) }
					: s,
		},
	)

const commit = (s: Working, c: Change): Working => {
	if (!owned(s, c))
		return fail(s, c, Cause.fail("Commit lost a version or reservation"))
	if (
		!HashMap.every(Attempt.declarations(c), (_, id) =>
			Option.exists(Attempt.unitFor(s, c, id), (unit) => live(s, unit.id)),
		)
	)
		return fail(s, c, Cause.fail("A required candidate group is unavailable"))
	const applied = HashSet.reduce(
		c.request.writes,
		HashSet.reduce(c.plan.members, s, forgetEndedCurrent),
		(s, key) => {
			const current = cell(s, key)
			return {
				...s,
				cells: HashMap.set(s.cells, key, {
					...current,
					version: current.version + 1,
				}),
			}
		},
	)
	const committed: Change = {
		...c,
		oldChanged: true,
		phase: "Trial",
		premises: HashMap.map(c.premises, (version, key) =>
			HashSet.has(c.request.writes, key) ? version + 1 : version,
		),
	}
	const next = save(
		{
			...applied,
			graph: c.recovering
				? applied.graph
				: Graph.commit(applied.graph, c.plan, false),
			routes: Bindings.commit(s, c),
			...Bindings.adopt(s, c),
			instances: HashSet.reduce(
				c.plan.members,
				applied.instances,
				(index, id) =>
					HashMap.modify(index, id, (instance) => ({
						...instance,
						current: Option.map(Attempt.unitFor(s, c, id), (unit) => unit.id),
					})),
			),
		},
		committed,
	)
	const resumed = HashSet.reduce(
		c.plan.members,
		disarm(next, c, HashSet.make("Operation")),
		Calls.resume,
	)
	const activated = HashSet.reduce(
		c.requiredParticipants,
		resumed,
		(s, participant) => issue(s, c.id, "Activate", participant, participant),
	)
	return arm(activated, c.id, "Trial", s.now + c.request.trial)
}

export const defaultBudget: Budget = {
	total: 300000,
	startup: 30000,
	probe: 5000,
	drain: 5000,
	stop: 5000,
	terminate: 5000,
}
export const normalizedIdentity = (
	input: Input,
	inspect = false,
): RequestIdentity => ({
	mode: inspect ? "Inspect" : "Deploy",
	operations: Arr.map(input.operations, (operation) =>
		operation._tag === "Remove"
			? { ...operation }
			: {
					...operation,
					realm: operation.realm ?? "root",
					colocate: Arr.copy(operation.colocate ?? []),
				},
	),
	realms: Arr.copy(input.realms ?? []),
	strategy: input.strategy ?? "Restart",
	budget: { ...defaultBudget, ...input.budget },
	probes: Arr.copy(input.requirements?.probes ?? []),
	trial: input.requirements?.trial ?? 0,
	completion: input.completion ?? "Serving",
})
const keyedReply = (
	s: Working,
	key: string,
	identity: RequestIdentity,
	fingerprint: string | undefined,
): Option.Option<Working> =>
	Option.orElse(
		Option.map(HashMap.get(s.keys, key), (prior) =>
			Equal.equals(prior.request.identity, identity)
				? ({
						...s,
						reply: { _tag: "Admitted", change: prior.change },
					} satisfies Working)
				: reject(s, "KeyConflict"),
		),
		() =>
			Option.orElse(
				Option.map(HashMap.get(s.priorKeys, key), (prior) =>
					fingerprint !== undefined && prior.request === fingerprint
						? reject(
								s,
								"AlreadyRecorded",
								HashSet.make(`${prior.run}/${prior.change}`),
							)
						: reject(s, "KeyConflict"),
				),
				() =>
					Option.flatMap(HashMap.get(s.preparationKeys, key), (id) =>
						Option.map(HashMap.get(s.preparations, id), (preparation) =>
							!preparation.inspect &&
							Equal.equals(preparation.request.identity, identity)
								? ({
										...s,
										reply: { _tag: "Preparing", preparation: id },
									} satisfies Working)
								: reject(s, "KeyConflict"),
						),
					),
			),
	)
const requested = (
	s: Working,
	input: InspectionInput,
	inspect = false,
	batch?: Input,
): Working => {
	const budget: Budget = { ...defaultBudget, ...input.budget }
	const target = InputSnapshot.target(input.target)
	const identity = normalizedIdentity(
		batch ?? {
			operations: [
				{
					_tag: "Deploy",
					instance: input.instance,
					target,
					...(input.realm === undefined ? {} : { realm: input.realm }),
					...(input.colocate === undefined ? {} : { colocate: input.colocate }),
					...(input.placement === undefined
						? {}
						: { placement: input.placement }),
					...(input.expected === undefined ? {} : { expected: input.expected }),
				},
			],
			realms: input.realms ?? [],
			strategy: input.strategy ?? "Restart",
			budget,
			requirements: {
				probes: input.requirements?.probes ?? [],
				trial: input.requirements?.trial ?? 0,
			},
		},
		inspect,
	)

	const request: Request = {
		...(batch === undefined ? {} : { operations: batch.operations }),
		realm: input.realm ?? "root",
		realms: identity.realms,
		colocate: Arr.copy(input.colocate ?? []),
		...(input.placement === undefined ? {} : { placement: input.placement }),
		instance: input.instance,
		target,
		identity,
		strategy: input.strategy ?? "Restart",
		reads:
			batch === undefined
				? HashMap.make([
						input.instance,
						input.expected ?? cell(s, input.instance).version,
					])
				: Arr.reduce(
						batch.operations,
						HashMap.empty<string, number>(),
						(reads, operation) =>
							HashMap.set(
								HashMap.set(
									reads,
									operation.instance,
									operation.expected ?? cell(s, operation.instance).version,
								),
								`authorization:${operation.instance}`,
								cell(s, `authorization:${operation.instance}`).version,
							),
					),
		writes: HashSet.make(input.instance),
		leases: HashSet.empty(),
		participants: HashSet.empty(),
		budget,
		probes: identity.probes,
		trial: identity.trial,
		...(input.key === undefined ? {} : { key: input.key }),
		...(batch?.completion === undefined
			? {}
			: { completion: batch.completion }),
		...(batch?.origin === undefined ? {} : { origin: batch.origin }),
		...(batch?.fingerprint === undefined
			? {}
			: { fingerprint: batch.fingerprint }),
	}

	if (input.key !== undefined && HashMap.has(s.keys, input.key))
		return submit(s, request)
	if (input.key !== undefined && HashMap.has(s.preparationKeys, input.key))
		return Preparation.start(s, request, inspect)
	if (!s.open) return reject(s, "Closing")
	if (!inspect && input.target.deployment?.inspection === "Module")
		return reject(s, "Unsupported")
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
	if (input.target.identity !== deploymentIdentity(input.target.deployment))
		return reject(s, "UnsupportedTarget")
	if (!Preparation.authorized(s, input.instance, input.target))
		return reject(s, "Unauthorized")
	const known = Preparation.cached(s, request)
	if (
		!inspect &&
		(batch === undefined || batch.operations.length === 1) &&
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
			proposal: Preparation.proposal(s, request, known.value.description),
			strategy: input.strategy ?? "Restart",
		})
	return Preparation.start(s, request, inspect)
}
const requestedBatch = (s: Working, input: Input): Working => {
	if (
		input.operations.length === 0 ||
		HashSet.size(
			HashSet.fromIterable(
				Arr.map(input.operations, (operation) => operation.instance),
			),
		) !== input.operations.length
	)
		return reject(s, "InvalidDeclaration")
	if (input.key !== undefined) {
		const prior = keyedReply(
			s,
			input.key,
			normalizedIdentity(input),
			input.fingerprint,
		)
		if (Option.isSome(prior)) return prior.value
	}
	const stale = Arr.filter(
		input.operations,
		(operation) =>
			operation.expected !== undefined &&
			operation.expected !== cell(s, operation.instance).version,
	)
	if (stale.length > 0)
		return reject(
			s,
			"Stale",
			HashSet.fromIterable(Arr.map(stale, (operation) => operation.instance)),
		)
	const invalid = Arr.some(
		input.operations,
		(operation) =>
			operation._tag === "Deploy" &&
			(operation.target.deployment === undefined ||
				operation.target.deployment.inspection === "Module" ||
				operation.target.identity !==
					deploymentIdentity(operation.target.deployment) ||
				!Preparation.authorized(s, operation.instance, operation.target)),
	)
	if (invalid) return reject(s, "Unauthorized")
	// Reconciling a committed removal needs the removed declaration; not supported yet.
	if (
		input.completion === "Committed" &&
		Arr.some(input.operations, (operation) => operation._tag === "Remove")
	)
		return reject(s, "Unsupported")
	if (
		Arr.some(
			input.operations,
			(operation) =>
				operation._tag === "Deploy" &&
				operation.target.deployment?.confinement === "Sandbox" &&
				operation.target.placement !== "Process",
		)
	)
		return reject(s, "UnsupportedTarget")
	const first = Arr.findFirst(
		input.operations,
		(operation) => operation._tag === "Deploy",
	)
	if (Option.isSome(first) && first.value._tag === "Deploy")
		return requested(s, { ...input, ...first.value }, false, input)
	const removed = HashSet.fromIterable(
		Arr.map(input.operations, (operation) => operation.instance),
	)
	const anchor = Option.flatMap(Arr.head(input.operations), (operation) =>
		HashMap.get(s.graph.declarations, operation.instance),
	)
	if (Option.isNone(anchor)) return reject(s, "UnsupportedTarget")
	const request: Request = {
		identity: normalizedIdentity(input),
		operations: input.operations,
		instance: anchor.value.instance,
		target: anchor.value.target,
		strategy: input.strategy ?? "Restart",
		budget: { ...defaultBudget, ...input.budget },
		trial: input.requirements?.trial ?? 0,
		reads: HashMap.fromIterable(
			Arr.map(input.operations, (operation) => [
				operation.instance,
				operation.expected ?? cell(s, operation.instance).version,
			]),
		),
		writes: removed,
		leases: HashSet.empty(),
		participants: HashSet.empty(),
		proposal: {
			members: [],
			explicit: removed,
			removed,
			realms: input.realms ?? [],
		},
		...(input.key === undefined ? {} : { key: input.key }),
	}
	return submit(s, request)
}
export const empty = (options: {
	readonly authority: string
	/** Unique per kernel start; tests may leave it out. */
	readonly run?: string
	readonly maxUnits: number
	readonly callLimits?: Partial<CallLimits>
	readonly bindings?: ReadonlyArray<FixedBinding>
	readonly recording?: RecordingDeclaration
	readonly supervision?: SupervisionDeclaration
	readonly instances: ReadonlyArray<{
		readonly id: string
		readonly target: Target
	}>
}): State => {
	const base = make({
		...options,
		declarations: [],
		realms: [{ id: "root", parent: Option.none(), isolated: HashSet.empty() }],
	})
	return Arr.reduce(options.instances, base, (s, entry) => ({
		...s,
		instances: HashMap.set(s.instances, entry.id, {
			id: entry.id,
			established: false,
			current: Option.none(),
			term: 0,
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
	return admit(s, r, r)
}

const admit = (s: Working, r: Request, identityRequest: Request): Working => {
	if (Option.isSome(s.graphIssue))
		return { ...s, reply: { _tag: "Rejected", ...s.graphIssue.value } }
	if (r.proposal === undefined) return reject(s, "InvalidDeclaration")
	return Result.match(Graph.plan(s, r.proposal, r.strategy), {
		onFailure: (issue) => ({ ...s, reply: { _tag: "Rejected", ...issue } }),
		onSuccess: (plan) =>
			HashMap.some(
				plan.dependencies,
				(dependencies, consumer) =>
					HashSet.has(plan.members, consumer) &&
					Arr.some(
						dependencies,
						(dependency) =>
							!dependency.optional &&
							Option.exists(
								dependency.provider,
								(provider) =>
									!HashSet.has(plan.members, provider) &&
									!Executions.healthy(s, provider),
							),
					),
			)
				? reject(s, "MissingProvider")
				: HashMap.some(
							plan.desired,
							(m) => !Preparation.authorized(s, m.instance, m.target),
					  )
					? reject(s, "Unauthorized")
					: Option.isSome(Recording.admission(s, plan))
						? refuseRecording(s, plan)
						: reserve(
								s,
								{
									...r,
									proposal: plan.proposal,
									reads: HashSet.reduce(plan.reads, r.reads, (reads, key) =>
										HashMap.has(reads, key)
											? reads
											: HashMap.set(reads, key, cell(s, key).version),
									),
									writes: HashSet.union(r.writes, plan.writes),
									leases: HashSet.union(r.leases, plan.leases),
									participants: HashSet.union(
										r.participants,
										plan.participants,
									),
								},
								plan,
								identityRequest,
							),
	})
}
const reserve = (
	s: Working,
	r: Request,
	plan: GroupPlan,
	identityRequest: Request,
): Working => {
	if (!s.open) return reject(s, "Closing")

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
				state: acc.state,
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
	const oldUnits = HashSet.fromIterable(
		Arr.flatMap(Arr.fromIterable(plan.members), (id) =>
			Option.toArray(
				Option.filter(
					Option.flatMap(
						HashMap.get(s.instances, id),
						(member) => member.current,
					),
					(unit) => live(s, unit),
				),
			),
		),
	)

	const oldClaims = HashSet.fromIterable(
		Arr.flatMap(Arr.fromIterable(oldUnits), (id) =>
			Option.toArray(
				Option.map(HashMap.get(s.units, id), (unit) => unit.claim),
			),
		),
	)
	const extra = Num.max(0, plan.peakUnits - HashSet.size(oldClaims))
	if (HashMap.size(s.claims) + extra > s.maxUnits)
		return reject(checked.state, "Capacity")
	const id = `change-${s.nextChange}`
	const claims = HashSet.reduce(oldClaims, s.claims, (out, key) =>
		HashMap.modify(out, key, (claim) => ({ ...claim, owner: id })),
	)
	const addedClaims = HashSet.fromIterable(
		extra === 0 ? [] : Arr.makeBy(extra, (index) => `${id}/capacity-${index}`),
	)
	const reserved = HashSet.reduce(addedClaims, claims, (out, key) =>
		HashMap.set(out, key, { id: key, owner: id, unit: Option.none() }),
	)

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
		plan,
		hadServing: HashSet.some(plan.members, (id) =>
			Option.exists(
				HashMap.get(s.instances, id),
				(member) => member.established,
			),
		),
		currentGroup: Option.none(),
		currentMember: Option.none(),
		loadedGroups: HashSet.empty(),
		resolvedMembers: HashSet.empty(),
		serveWave: 0,
		pendingUnits: HashSet.empty(),
		resolutions:
			r.resolution === undefined
				? HashMap.empty()
				: HashMap.make([r.instance, r.resolution]),
		descriptions:
			r.description === undefined
				? HashMap.empty()
				: HashMap.make([r.instance, r.description]),
		policyVersion: r.policyVersion ?? 0,
		id,
		request: r,
		startingVersions: HashMap.fromIterable(
			Arr.map(Arr.fromIterable(plan.members), (member) => [
				member,
				cell(s, member).version,
			]),
		),
		startingHealth: HashMap.fromIterable(
			Arr.map(Arr.fromIterable(plan.members), (member) => [
				member,
				Executions.healthy(s, member),
			]),
		),
		phase: "Resolving",
		interrupted: Option.none(),
		oldUnits,
		candidates: HashMap.empty(),
		units: oldUnits,
		requiredExits: HashSet.empty(),
		claims: HashSet.union(oldClaims, addedClaims),
		premises: r.reads,
		oldChanged: false,
		recovering: false,
		recoveryFailed: false,
		failure: false,
		shuttingDown: false,
		cancelRequested: false,
		invalidated: HashSet.empty(),
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
		transferred: HashSet.empty(),
		released: false,
		recorded: Recording.required(s, plan),
		recordingGate: Option.none(),
		executed: Option.none(),
	}
	const admitted = save(
		{
			...checked.state,
			recordsPromised:
				checked.state.recordsPromised +
				(c.recorded ? Recording.stages.length : 0),
			graph: { ...checked.state.graph, nextGroup: plan.nextGroup },
			cells: locks,
			claims: reserved,
			units: HashSet.reduce(oldUnits, s.units, (out, key) =>
				HashMap.modify(out, key, (unit) => ({ ...unit, owner: id })),
			),
			instances: HashSet.reduce(plan.members, s.instances, (out, member) =>
				HashMap.has(out, member)
					? out
					: Option.match(HashMap.get(plan.desired, member), {
							onNone: () => out,
							onSome: () =>
								HashMap.set(out, member, {
									id: member,
									established: false,
									current: Option.none(),
									term: 0,
								}),
						}),
			),
			active: HashSet.add(s.active, id),
			observers: HashSet.reduce(keys(r), s.observers, (observers, key) =>
				HashMap.set(
					observers,
					key,
					HashSet.add(
						Option.getOrElse(HashMap.get(observers, key), () =>
							HashSet.empty<string>(),
						),
						id,
					),
				),
			),
			nextChange: s.nextChange + 1,
			keys:
				r.key === undefined
					? s.keys
					: HashMap.set(s.keys, r.key, {
							request: identityRequest,
							change: id,
						}),
			reply: { _tag: "Admitted", change: id },
		},
		c,
	)
	const timed = arm(admitted, id, "Total", c.deadline - r.budget.terminate)
	return withChange(timed, id, (s, c) =>
		c.recorded ? gate(s, c, "Intent", Option.none()) : begin(s, c),
	)
}
/** The first lifecycle action of an admitted Change; recorded Changes reach it only after an acknowledged intent. */
const begin = (s: Working, c: Change): Working =>
	c.request.completion === "Committed"
		? commitDesired(s, c)
		: c.request.strategy === "Restart" && HashSet.size(c.oldUnits) > 0
			? stopOld(s, c)
			: resolve(s, c)
/**
 * `Committed` completion: the validated desired state is recorded and becomes the
 * supervisor's; nothing is started here. Reconciliation runs as its own Change.
 */
const commitDesired = (s: Working, c: Change): Working => {
	if (c.recorded && !Recording.acknowledged(s, c.id, "Commit"))
		return gate(s, c, "Commit", Option.none())
	if (!owned(s, c))
		return fail(s, c, Cause.fail("Commit lost a version or reservation"))
	const applied = HashSet.reduce(c.request.writes, s, (s, key) => {
		const current = cell(s, key)
		return {
			...s,
			cells: HashMap.set(s.cells, key, {
				...current,
				version: current.version + 1,
			}),
		}
	})
	const next: Change = { ...c, phase: "Settling" }
	const committed = save(
		{ ...applied, graph: Graph.commit(applied.graph, c.plan, false) },
		next,
	)
	return reconcile(
		conclude(committed, next, "Accepted"),
		c.id,
		c.plan.members,
		{
			probes: c.request.probes ?? [],
			trial: c.request.trial,
		},
	)
}
/**
 * Brings members whose running target differs from the desired one to it, in one
 * ordinary Change linked to `origin`. Planned work, so it is no restart attempt.
 */
const reconcile = (
	s: Working,
	origin: string,
	members: HashSet.HashSet<string>,
	requirements: PendingRestart["requirements"],
): Working => {
	const differing = HashSet.filter(members, (id) =>
		Option.exists(
			HashMap.get(s.graph.declarations, id),
			(m) =>
				Preparation.authorized(s, id, m.target) &&
				!(
					Executions.healthy(s, id) &&
					Option.exists(Executions.current(s, id), ({ member }) =>
						// The whole target: its identity leaves out configuration and placement.
						Recording.sameTarget(member.target, m.target),
					)
				),
		),
	)
	if (!s.open || HashSet.size(differing) === 0) return s
	const restart: PendingRestart = {
		kind: "Reconcile",
		unit: origin,
		members: differing,
		cause: Cause.empty,
		...(requirements === undefined ? {} : { requirements }),
	}
	if (HashSet.some(differing, (id) => Option.isSome(cell(s, id).writer)))
		return defer(s, restart)
	const submitted = requestedBatch(s, {
		operations: Arr.flatMap(Arr.fromIterable(differing), (id) =>
			Option.toArray(
				Option.map(
					HashMap.get(s.graph.declarations, id),
					(m): DeploymentOperation => ({
						_tag: "Deploy",
						instance: id,
						target: m.target,
					}),
				),
			),
		),
		strategy: "Restart",
		origin,
		// The committed request's probes and trial apply when its state is reached.
		...(requirements === undefined ? {} : { requirements }),
	})
	const reply = submitted.reply
	const next: Working = { ...submitted, reply: s.reply }
	if (reply._tag === "Rejected")
		return reply.reason === "Busy" || reply.reason === "Capacity"
			? defer(next, restart)
			: next
	return reply._tag === "Preparing"
		? {
				...next,
				preparations: HashMap.modify(
					next.preparations,
					reply.preparation,
					(p) => ({ ...p, request: { ...p.request, supervised: restart } }),
				),
			}
		: next
}
/** Holds the Change at a recording stage until the owner acknowledges the stage's record. */
const gate = (
	s: Working,
	c: Change,
	stage: RecordStage,
	outcome: Option.Option<Outcome>,
): Working => {
	const held: Change = { ...c, recordingGate: Option.some(stage) }
	return Recording.request(
		save(s, held),
		held,
		stage,
		outcome,
		recordFacts(Option.getOrElse(c.executed, () => members(s, c))),
	)
}
const refuseRecording = (s: Working, plan: GroupPlan): Working =>
	Option.match(Recording.admission(s, plan), {
		onNone: () => s,
		onSome: (refusal) => reject(s, refusal.reason, refusal.conflicts),
	})
/** Route activation needs an acknowledged commit decision; recovery restores safety and is never gated. */
const commitRecorded = (s: Working, c: Change): Working =>
	c.recorded && !c.recovering && !Recording.acknowledged(s, c.id, "Commit")
		? gate(s, c, "Commit", Option.none())
		: commit(s, c)
/** Continues the stage a discharged duty was holding, under the Change's current premises and budget. */
const resume = (s: Working, c: Change, stage: RecordStage): Working => {
	if (!Option.contains(c.recordingGate, stage) || Option.isSome(c.conclusion))
		return s
	const released: Change = { ...c, recordingGate: Option.none() }
	const saved = save(s, released)
	switch (stage) {
		case "Intent":
			return released.failure || released.cancelRequested
				? saved
				: expired(released, s)
					? fail(
							saved,
							released,
							Cause.fail("Absolute submission deadline exhausted"),
						)
					: begin(saved, released)
		case "Commit":
			return released.failure
				? saved
				: expired(released, s)
					? fail(
							saved,
							released,
							Cause.fail("Absolute submission deadline exhausted"),
						)
					: released.request.completion === "Committed"
						? commitDesired(saved, released)
						: commit(saved, released)
		case "Conclusion":
			return conclude(saved, released, "Accepted")
	}
}
const recordingSignal = (
	s: Working,
	event: Extract<
		Event,
		{ readonly _tag: "RecorderRegistered" | "RecordAcknowledged" }
	>,
): Working => {
	if (event._tag === "RecorderRegistered") return Recording.register(s, event)
	const result = Recording.acknowledge(s, event)
	switch (result._tag) {
		case "Rejected":
			return reject(s, "Stale", HashSet.make(event.record))
		case "Repeated":
			return s
		case "Discharged": {
			const discharged: Working = {
				...s,
				records: HashMap.set(s.records, result.duty.id, result.duty),
				recordsOutstanding: s.recordsOutstanding - 1,
			}
			return withChange(discharged, result.duty.payload.change, (s, c) =>
				resume(save(s, c), c, result.duty.payload.stage),
			)
		}
	}
}
const memberRequest = (c: Change, member: MemberDeclaration): Request => {
	const {
		key: _key,
		identity: _identity,
		operations: _operations,
		placement: _placement,
		...request
	} = c.request
	const explicit = c.recovering
		? Option.none()
		: Arr.findFirst(
				c.request.operations ?? [],
				(operation) =>
					operation._tag === "Deploy" && operation.instance === member.instance,
			)
	const placement =
		Option.isSome(explicit) && explicit.value._tag === "Deploy"
			? Option.fromUndefinedOr(explicit.value.placement)
			: member.placement
	return {
		...request,
		instance: member.instance,
		member,
		target: member.target,
		realm: member.realm,
		colocate: member.colocate,
		boundary: Option.getOrElse(
			Option.flatMap(c.currentGroup, (id) =>
				HashMap.get(Attempt.groups(c), id),
			).pipe(Option.map((group) => group.placement)),
			() => ({ kind: member.target.placement }),
		),
		...Option.match(placement, {
			onNone: () => ({}),
			onSome: (placement) => ({ placement }),
		}),
	}
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
	const focused = Attempt.current(c)
	if (Option.isNone(focused))
		return fail(s, c, Cause.fail("Inspection has no granted member"))
	const started = Preparation.start(
		disarm(s, c, HashSet.make("Operation")),
		memberRequest(c, focused.value),
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
const retainDescription = (c: Change, description: Description): Change => ({
	...c,
	descriptions: Arr.reduce(
		description.members,
		c.descriptions,
		(index, member) => HashMap.set(index, member.instance, description),
	),
})
const descriptionReady = (
	s: Working,
	ready: Working["descriptions"][number],
): Working =>
	withChange(s, ready.change, (s, c) => {
		if (Option.isSome(c.conclusion)) return s
		if (ready.result._tag !== "Described") return fail(s, c, ready.cause)
		if (c.failure) return progressSettlement(s, c)
		const description = ready.result.description
		if (
			!Arr.every(description.members, (member) =>
				Option.exists(
					HashMap.get(Attempt.declarations(c), member.instance),
					(expected) => Equal.equals(expected, member),
				),
			)
		)
			return fail(
				s,
				c,
				Cause.fail(
					"Fresh declarations differ from the reserved group footprint",
				),
			)
		const next = retainDescription(c, description)
		return resolve(save(s, next), next)
	})
const resolvedMember = (s: Working, c: Change, command: Command): Working => {
	const member = Attempt.current(c)
	if (Option.isNone(member))
		return fail(s, c, Cause.fail("The resolution has no admitted member"))
	if (!Preparation.authorized(s, member.value.instance, member.value.target))
		return fail(s, c, Cause.fail("Current policy denies execution"))
	const evidence = Option.filter(
		command.report,
		(report) => report._tag === "Resolved",
	)
	const next = {
		...c,
		resolvedMembers: HashSet.add(c.resolvedMembers, member.value.instance),
		resolutions: Option.match(evidence, {
			onNone: () => c.resolutions,
			onSome: (report) =>
				HashMap.set(c.resolutions, member.value.instance, report.value),
		}),
	}
	const value = HashMap.get(next.resolutions, member.value.instance)
	if (member.value.target.deployment === undefined)
		return resolve(save(s, next), next)
	if (Option.isNone(value))
		return fail(
			s,
			c,
			Cause.fail("The resolver returned no encoded member configuration"),
		)
	const request = memberRequest(c, member.value)
	const known = Preparation.cached(s, request, value.value)
	if (Option.isSome(known)) {
		const verified = retainDescription(next, known.value.description)
		return resolve(save(s, verified), verified)
	}
	return inspectAttempt(save(s, next), next, value.value)
}
const completeCollective = (
	s: Working,
	c: Change,
	command: Command,
	kind: "Ready" | "Probe",
): Working => {
	const next = {
		...c,
		pendingUnits: HashSet.remove(c.pendingUnits, command.unit),
	}
	const evidenced =
		kind === "Ready"
			? withUnit(s, command.unit, (s, unit) => ({
					...s,
					units: HashMap.set(
						s.units,
						unit.id,
						Executions.update(unit, command.subjects, "Ready"),
					),
				}))
			: s
	const saved = save(evidenced, next)
	return HashSet.size(next.pendingUnits) > 0
		? saved
		: kind === "Ready"
			? collective(saved, next, "Probe", "Probing", c.request.budget.probe)
			: install(saved, next)
}
const reportSuccess = (s: Working, c: Change, command: Command): Working => {
	if (Option.isSome(c.conclusion) || c.failure) return s
	switch (command.kind) {
		case "Resolve":
			return c.phase === "Resolving" ? resolvedMember(s, c, command) : s
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
			return c.phase !== "Starting"
				? s
				: withUnit(s, command.unit, (s, unit) => {
						const evidence = Option.filter(
							command.report,
							(report) => report._tag === "Started",
						)
						if (
							Option.isSome(unit.description) &&
							!Option.exists(
								evidence,
								(report) =>
									(!Arr.some(
										report.value.members,
										(member) => member.provides.length > 0,
									) ||
										Arr.every(
											report.value.members,
											(member) =>
												member.provides.length === 0 ||
												HashMap.has(report.endpoints, member.instance),
										)) &&
									Equal.equals(
										report.value,
										unit.description.pipe(Option.getOrUndefined),
									),
							)
						)
							return fail(
								s,
								c,
								Cause.fail("Execution declarations differ from inspection"),
							)
						const loaded = {
							...c,
							loadedGroups: HashSet.add(c.loadedGroups, unit.group),
						}
						const saved = save(
							{
								...s,
								units: HashMap.set(s.units, unit.id, {
									...unit,
									members: HashMap.map(unit.members, (member) => ({
										...member,
										endpoint: Option.flatMap(evidence, (report) =>
											HashMap.get(report.endpoints, member.instance),
										),
									})),
									description: Option.orElse(
										Option.map(evidence, (report) => report.value),
										() => unit.description,
									),
								}),
							},
							loaded,
						)
						return resolve(saved, loaded)
					})
		case "Serve": {
			if (c.phase !== "Serving") return s
			const next = {
				...c,
				pendingUnits: HashSet.remove(c.pendingUnits, command.unit),
			}
			return HashSet.size(next.pendingUnits) === 0
				? serveWave(save(s, next), { ...next, serveWave: c.serveWave + 1 })
				: save(s, next)
		}
		case "Ready":
			return c.phase === "Readiness"
				? completeCollective(s, c, command, "Ready")
				: s
		case "Probe":
			return c.phase === "Probing"
				? completeCollective(s, c, command, "Probe")
				: s
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
				? commitRecorded(saved, next)
				: saved
		}
		case "Activate":
		case "Stop":
		case "Terminate":
		case "ArmTimer":
		case "Discard":
		case "Record":
		case "Describe":
		case "PublishPreparation":
		case "Publish":
		case "CancelTimer":
		case "RetireRoute":
		case "CallRegister":
		case "CallGrant":
		case "StopMembers":
		case "ServeMembers":
		case "RestartMembers":
		case "ReadyMembers":
		case "CallReject":
		case "CallCancel":
		case "CallCompleteAck":
		case "CallArmTimer":
		case "PublishCall":
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
		members: HashMap.map(u.members, (member) => ({
			...member,
			phase: evidence === "NotStarted" ? "NotStarted" : "Stopped",
			cleanup: member.cleanup._tag === "Unknown" ? cleanup : member.cleanup,
			cause: Cause.combine(member.cause, cause),
		})),
		evidence,
		phase: evidence === "NotStarted" ? "NotStarted" : "Exited",
		cleanup:
			u.cleanup._tag === "Failed" || cleanup._tag === "Unknown"
				? u.cleanup
				: cleanup,
		cause: Cause.combine(u.cause, cause),
		leases: HashSet.empty(),
	}
	const claim = HashMap.get(s.claims, u.claim)
	const endedCalls = Members.ended(Calls.ended(s, ended), ended)
	const next: Working = {
		...endedCalls,
		instances: HashMap.reduce(
			u.members,
			endedCalls.instances,
			(instances, member) =>
				HashMap.modify(instances, member.instance, (instance) =>
					Option.contains(instance.current, u.id)
						? { ...instance, current: Option.none() }
						: instance,
				),
		),
		changed: HashSet.union(
			endedCalls.changed,
			HashMap.reduce(u.members, HashSet.empty<string>(), (ids, member) =>
				HashSet.union(
					ids,
					Option.getOrElse(
						HashMap.get(s.observers, member.instance),
						HashSet.empty<string>,
					),
				),
			),
		),
		units: HashMap.set(s.units, u.id, ended),
		claims: Option.match(claim, {
			onNone: () => s.claims,
			onSome: (claim) =>
				claim.owner === `group:${u.group}`
					? HashMap.remove(s.claims, u.claim)
					: HashMap.set(s.claims, u.claim, { ...claim, unit: Option.none() }),
		}),
	}
	const settled = HashSet.reduce(
		HashSet.add(
			HashMap.reduce(u.members, HashSet.empty<string>(), (ids, member) =>
				HashSet.union(
					ids,
					Option.getOrElse(
						HashMap.get(s.observers, member.instance),
						HashSet.empty<string>,
					),
				),
			),
			u.owner,
		),
		next,
		(s, id) =>
			withChange(s, id, (s, c) => {
				const observed = {
					...c,
					cause: Cause.combine(
						c.cause,
						cleanup._tag === "Failed"
							? Cause.combine(cause, cleanup.cause)
							: cause,
					),
				}
				const saved = save(s, observed)
				if (Option.isSome(c.conclusion)) return release(saved, observed)
				if (cleanup._tag === "Failed" && !c.failure)
					return fail(saved, observed, Cause.empty)
				if (HashSet.has(Attempt.units(c), u.id) && !c.failure)
					return fail(saved, observed, Cause.fail("Candidate execution exited"))
				if (
					HashSet.has(c.oldUnits, u.id) &&
					!HashSet.has(c.requiredExits, u.id) &&
					!c.failure
				)
					return fail(
						saved,
						observed,
						Cause.fail("Previous execution exited unexpectedly"),
					)
				return progressSettlement(saved, observed)
			}),
	)
	/**
	 * Nothing owned this exit, or its Change had finished executing and only waits for
	 * its concluding record: the supervisor redeploys the group once it has settled.
	 */
	const finished = Option.exists(
		HashMap.get(s.changes, u.owner),
		(c) =>
			Option.isNone(c.conclusion) &&
			Option.contains(c.recordingGate, "Conclusion"),
	)
	return u.kind === "Execution" &&
		evidence === "Exited" &&
		(u.owner === `group:${u.group}` || finished)
		? superviseUnit(
				settled,
				u.id,
				HashSet.fromIterable(HashMap.keys(u.members)),
				cause,
			)
		: settled
}
const currentReport = (c: Change, command: Command): boolean =>
	command.token.view === c.view &&
	(command.kind === "Resolve" ||
		command.kind === "Stop" ||
		command.kind === "Terminate" ||
		command.kind === "ArmTimer" ||
		command.kind === "Publish" ||
		((command.kind === "Install" ||
			command.kind === "Activate" ||
			command.kind === "Discard") &&
			HashSet.has(c.requiredParticipants, command.unit)) ||
		HashSet.has(Attempt.units(c), command.unit))
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
			if (command.change === Recording.commands) return recorded
			if (command.change === "$calls")
				return Calls.reported(recorded, {
					...command,
					report: Option.some(event.result),
				})
			if (HashMap.has(recorded.memberOperations, command.change))
				return Members.reported(recorded, {
					...command,
					report: Option.some(event.result),
				})
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
const expiredInstallation = (s: Working, c: Change): Working => {
	const missing = HashSet.filter(
		c.requiredParticipants,
		(id) => !HashSet.has(c.installed, id) && live(s, id),
	)
	const required = {
		...c,
		units: HashSet.union(c.units, missing),
		requiredExits: HashSet.union(c.requiredExits, missing),
	}
	const unavailable: Working = {
		...s,
		units: HashSet.reduce(missing, s.units, (index, id) =>
			HashMap.modify(index, id, (unit) =>
				Executions.update(
					unit,
					HashSet.fromIterable(HashMap.keys(unit.members)),
					"Failed",
				),
			),
		),
	}
	return fail(unavailable, required, Cause.fail("Installing deadline expired"))
}
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
					case "Restart":
						return s
					case "Trial": {
						if (c.phase !== "Trial") return s
						const passed = { ...c, trialPassed: true }
						return c.recovering ||
							c.request.strategy === "Restart" ||
							HashSet.size(c.oldUnits) === 0
							? conclude(
									save(s, passed),
									passed,
									c.recovering ? "Recovered" : "Accepted",
								)
							: stopOld(save(s, passed), passed)
					}
					case "Operation": {
						if (c.phase === "Draining") {
							const cancelled = HashSet.reduce(
								c.oldUnits,
								s,
								Calls.cancelProvider,
							)
							const stopping: Change = { ...c, phase: "Retiring" }
							const issued = HashSet.reduce(
								c.oldUnits,
								save(cancelled, stopping),
								(s, id) => (live(s, id) ? issue(s, c.id, "Stop", id) : s),
							)
							return arm(
								issued,
								c.id,
								"Operation",
								Num.min(
									s.now + c.request.budget.stop,
									c.deadline - c.request.budget.terminate,
								),
							)
						}
						if (c.phase === "Installing") return expiredInstallation(s, c)
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
		...s,
		units: Option.match(Executions.current(s, event.object), {
			onNone: () => s.units,
			onSome: ({ unit }) =>
				HashMap.set(s.units, unit.id, {
					...Executions.update(unit, HashSet.make(event.object), "Failed"),
					cause: Cause.combine(unit.cause, event.cause),
				}),
		}),
		cells: HashMap.set(s.cells, event.object, {
			...current,
			version: current.version + 1,
		}),
	}
	const owners = HashSet.union(
		current.readers,
		HashSet.fromIterable(Option.toArray(current.writer)),
	)
	return HashSet.reduce(owners, next, (s, id) =>
		withChange(s, id, (s, c) =>
			fail(
				s,
				{ ...c, invalidated: HashSet.add(c.invalidated, event.object) },
				event.cause,
			),
		),
	)
}
const shutdownUnit = (s: Working, u: Unit): Working => {
	if (u.evidence !== "Missing" || u.phase === "Terminating") return s
	const first = Arr.head(Arr.fromIterable(HashMap.values(u.members)))
	if (Option.isNone(first)) return s
	const id = `${s.authority}/shutdown/${u.id}`
	const command: Command = {
		subjects: HashSet.fromIterable(HashMap.keys(u.members)),
		placement: u.placement,
		resolutions: HashMap.empty(),
		descriptions: HashMap.empty(),
		policies: HashMap.empty(),
		members: Executions.grants(u.members),
		dispatched: true,
		id,
		change: "$runtime",
		kind: "Terminate",
		unit: u.id,
		target: first.value.target,
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
			members: Executions.tokens(u.members),
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
		...Supervisor.cancel(s),
		open: false,
		units: HashMap.map(s.units, (unit) =>
			Executions.update(
				unit,
				HashSet.fromIterable(HashMap.keys(unit.members)),
				"Stopping",
			),
		),
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
	const current = cell(s, `authorization:${event.instance}`)
	const next: Working = {
		...s,
		cells: HashMap.set(s.cells, `authorization:${event.instance}`, {
			...current,
			version: current.version + 1,
		}),
		policies: HashMap.set(s.policies, event.instance, {
			version: previous.version + 1,
			allowed:
				event.allowed === undefined
					? previous.allowed
					: Option.some(HashSet.fromIterable(event.allowed)),
			sandbox: event.sandbox ?? previous.sandbox,
			values: InputSnapshot.values(event.values),
		}),
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
					: fail(
							s,
							c,
							Cause.fail(
								event.allowed === undefined && event.sandbox === undefined
									? "Current reference values changed"
									: "Current authorization premise changed",
							),
						),
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
		const changed = HashMap.reduce(
			u.members,
			HashSet.empty<string>(),
			(ids, member) =>
				HashSet.union(
					ids,
					Option.getOrElse(
						HashMap.get(s.observers, member.instance),
						HashSet.empty<string>,
					),
				),
		)
		const observed: Working = {
			...s,
			units: HashMap.set(s.units, u.id, {
				...Executions.update(
					u,
					HashSet.fromIterable(HashMap.keys(u.members)),
					"Failed",
				),
				cause: Cause.combine(u.cause, event.cause),
			}),
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
									oldChanged: c.oldChanged || HashSet.has(c.oldUnits, u.id),
								},
								event.cause,
							),
				),
		)
		return !HashMap.has(s.changes, u.owner)
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
						cleanup: u.cleanup._tag === "Failed" ? u.cleanup : event.cleanup,
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
			HashMap.reduce(u.members, HashSet.empty<string>(), (ids, member) =>
				HashSet.union(
					ids,
					Option.getOrElse(
						HashMap.get(s.observers, member.instance),
						HashSet.empty<string>,
					),
				),
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
const memberSignal = (
	s: Working,
	event: Extract<
		Event,
		{ _tag: "MemberReady" | "MemberFailed" | "MemberStopped" }
	>,
): Working =>
	withUnit(s, event.unit, (s, unit) => {
		if (
			unit.incarnation !== event.incarnation ||
			unit.spawn !== event.observer ||
			unit.evidence !== "Missing"
		)
			return s
		const member = HashMap.get(unit.members, event.member)
		if (
			Option.isNone(member) ||
			member.value.term !== event.term ||
			member.value.generation !== event.generation
		)
			return s
		if (member.value.phase === "Stopped" || member.value.phase === "NotStarted")
			return s
		const updated = {
			...unit,
			members: HashMap.set(unit.members, event.member, {
				...member.value,
				phase:
					event._tag === "MemberStopped"
						? "Stopped"
						: event._tag === "MemberFailed"
							? "Failed"
							: member.value.phase === "Starting" ||
								  member.value.phase === "Preparing"
								? "Ready"
								: member.value.phase,
				cleanup:
					event._tag === "MemberStopped" ? event.cleanup : member.value.cleanup,
				cause:
					event._tag === "MemberReady"
						? member.value.cause
						: Cause.combine(member.value.cause, event.cause),
			} satisfies MemberExecution),
		}
		const observers = Option.getOrElse(
			HashMap.get(s.observers, event.member),
			HashSet.empty<string>,
		)
		const observed: Working = {
			...s,
			units: HashMap.set(s.units, unit.id, updated),
			changed: HashSet.union(s.changed, observers),
		}
		if (event._tag === "MemberStopped")
			return Members.stopped(observed, updated)
		if (event._tag === "MemberReady") return observed
		const affected = Executions.affect(updated, event.member)
		const owners = HashSet.reduce(
			affected,
			HashSet.empty<string>(),
			(ids, member) =>
				HashSet.union(
					ids,
					HashSet.union(
						cell(s, member).readers,
						HashSet.fromIterable(Option.toArray(cell(s, member).writer)),
					),
				),
		)
		if (HashSet.size(owners) > 0)
			return HashSet.reduce(owners, observed, (s, id) =>
				HashMap.has(s.memberOperations, id)
					? Members.failed(s, id, event.cause)
					: withChange(s, id, (s, change) =>
							Option.isSome(change.conclusion)
								? s
								: HashSet.has(Attempt.units(change), unit.id)
									? fail(s, change, event.cause)
									: fail(
											s,
											{
												...change,
												invalidated: HashSet.add(
													change.invalidated,
													event.member,
												),
												oldChanged:
													change.oldChanged ||
													HashSet.has(change.oldUnits, unit.id),
											},
											event.cause,
										),
						),
			)
		return superviseMembers(observed, updated, affected, event.cause)
	})
/** A failure no Change owns: restart within the intensity, wait while busy, otherwise escalate and only stop. */
const superviseMembers = (
	s: Working,
	unit: Unit,
	affected: HashSet.HashSet<string>,
	cause: Cause.Cause<unknown>,
	pending?: PendingRestart,
): Working => {
	if (!s.open) return s
	// A revoked target only stops: it is never granted again, so it is no attempt
	// and does not hold back its authorized co-members, its intensity included.
	const permitted = HashSet.filter(affected, (id) =>
		Option.exists(HashMap.get(unit.members, id), (member) =>
			Preparation.authorized(s, id, member.target),
		),
	)
	if (!Supervisor.allows(s, permitted))
		return Members.start(
			Supervisor.escalate(s, permitted),
			unit,
			affected,
			cause,
			false,
		)
	const restart = pending ?? {
		kind: "Members",
		unit: unit.id,
		members: affected,
		cause,
	}
	const waiting = Supervisor.wait(s, restart, permitted)
	if (Option.isSome(waiting)) return waiting.value
	const started = Members.start(s, unit, affected, cause, true, permitted)
	return started.nextMemberOperation === s.nextMemberOperation
		? defer(s, restart)
		: Supervisor.attempted(started, permitted)
}
const defer = (s: Working, restart: PendingRestart): Working => ({
	...s,
	pendingRestarts: HashMap.set(
		s.pendingRestarts,
		`${restart.kind}:${restart.unit}`,
		restart,
	),
})
/** A crashed unit no Change owns: after the group settles, one supervisor Change redeploys its desired targets. */
const superviseUnit = (
	s: Working,
	unit: string,
	members: HashSet.HashSet<string>,
	cause: Cause.Cause<unknown>,
	pending?: PendingRestart,
): Working => {
	// Current policy decides: a revoked target is not redeployed, and is not an attempt.
	const declared = HashSet.filter(members, (id) =>
		Option.exists(HashMap.get(s.graph.declarations, id), (m) =>
			Preparation.authorized(s, id, m.target),
		),
	)
	if (!s.open || HashSet.size(declared) === 0) return s
	if (!Supervisor.allows(s, declared)) return Supervisor.escalate(s, declared)
	const restart: PendingRestart =
		pending === undefined
			? { kind: "Unit", unit, members: declared, cause }
			: { ...pending, members: declared }
	const waiting = Supervisor.wait(s, restart, declared)
	if (Option.isSome(waiting)) return waiting.value
	if (HashSet.some(declared, (id) => Option.isSome(cell(s, id).writer)))
		return defer(s, restart)
	const operations = Arr.flatMap(Arr.fromIterable(declared), (id) =>
		Option.toArray(
			Option.map(
				HashMap.get(s.graph.declarations, id),
				(m): DeploymentOperation => ({
					_tag: "Deploy",
					instance: id,
					target: m.target,
				}),
			),
		),
	)
	const submitted = requestedBatch(s, { operations, strategy: "Restart" })
	const reply = submitted.reply
	const next: Working = { ...submitted, reply: s.reply }
	if (reply._tag === "Rejected")
		return reply.reason === "Busy" || reply.reason === "Capacity"
			? defer(next, restart)
			: Supervisor.escalate(next, declared)
	return Supervisor.attempted(
		reply._tag === "Preparing"
			? {
					...next,
					preparations: HashMap.modify(
						next.preparations,
						reply.preparation,
						(p) => ({ ...p, request: { ...p.request, supervised: restart } }),
					),
				}
			: next,
		declared,
	)
}
/** A prepared supervisor restart that admission finds busy is deferred again; the attempt is taken back. */
const admittedRestart = (s: Working, request: Request): Working =>
	request.supervised !== undefined &&
	s.reply._tag === "Rejected" &&
	(s.reply.reason === "Busy" || s.reply.reason === "Capacity")
		? defer(
				request.supervised.kind === "Reconcile"
					? s
					: Supervisor.refunded(s, request.supervised.members),
				request.supervised,
			)
		: s
/** Deferred restarts are tried again after every event; one that still conflicts stays deferred. */
const retryPending = (s: Working): Working =>
	HashMap.reduce(s.pendingRestarts, s, (next, restart, key) => {
		if (!next.open || Supervisor.waiting(next, restart)) return next
		const cleared = {
			...next,
			pendingRestarts: HashMap.remove(next.pendingRestarts, key),
		}
		if (restart.kind === "Reconcile")
			return reconcile(
				cleared,
				restart.unit,
				restart.members,
				restart.requirements,
			)
		if (restart.kind === "Unit")
			return superviseUnit(
				cleared,
				restart.unit,
				restart.members,
				restart.cause,
				restart,
			)
		return Option.match(HashMap.get(cleared.units, restart.unit), {
			onNone: () => cleared,
			onSome: (u) =>
				u.evidence === "Missing"
					? superviseMembers(
							cleared,
							u,
							restart.members,
							restart.cause,
							restart,
						)
					: cleared,
		})
	})
const apply = (s: Working, event: Event): Working => {
	switch (event._tag) {
		case "MemberReady":
		case "MemberFailed":
		case "MemberStopped":
			return memberSignal(s, event)
		case "CallObserved":
			return withUnit(Calls.observed(s, event), event.unit, Members.stopped)
		case "CallExpired":
			return Calls.expired(s, event.key)
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
				: disconnected(Calls.disconnected(s, event), event)
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
			if (
				Option.exists(
					HashMap.get(s.timers, event.timer),
					(t) => t.purpose === "Restart",
				)
			)
				return Supervisor.observeTimer(s, event)
			if (
				Option.exists(HashMap.get(s.timers, event.timer), (timer) =>
					HashMap.has(s.memberOperations, timer.change),
				)
			)
				return Members.timerEnded(s, event)
			return Option.exists(HashMap.get(s.timers, event.timer), (t) =>
				HashMap.has(s.preparations, t.change),
			)
				? Preparation.timerEnded(s, event)
				: timerEnded(s, event)
		case "Requested":
			return requestedBatch(s, event.request)
		case "InspectRequested":
			return requested(s, event.request, true)
		case "PreparationObserved":
			return Preparation.observed(s, event.preparation)
		case "PolicyChanged":
			return policyChanged(s, event)
		case "RecordingDeclared":
			return Recording.declare(s, event.declaration)
		case "Observed":
			return withChange(s, event.change, save)
		case "Submit":
			return submit(s, InputSnapshot.request(event.request))
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
			if (
				Option.exists(
					HashMap.get(s.timers, event.timer),
					(t) => t.purpose === "Restart",
				)
			)
				return Supervisor.observeTimer(s, event)
			if (
				Option.exists(HashMap.get(s.timers, event.timer), (timer) =>
					HashMap.has(s.memberOperations, timer.change),
				)
			)
				return Option.match(HashMap.get(s.timers, event.timer), {
					onNone: () => s,
					onSome: (timer) =>
						timer.active &&
						timer.generation === event.generation &&
						timer.deadline <= s.now
							? Members.timer(s, timer)
							: s,
				})
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
			return Preparation.shutdown(shutdown(Calls.closed(s)))
		case "RecorderRegistered":
		case "RecordAcknowledged":
			return recordingSignal(s, event)
	}
}
const eventOwners = (s: State, event: Event): HashSet.HashSet<string> => {
	switch (event._tag) {
		case "MemberReady":
		case "MemberFailed":
		case "MemberStopped":
			return Option.getOrElse(
				HashMap.get(s.observers, event.member),
				HashSet.empty<string>,
			)
		case "CallObserved":
		case "CallExpired":
			return HashSet.empty()
		case "Observed":
			return HashSet.make(event.change)
		case "InspectRequested":
		case "PreparationObserved":
		case "PolicyChanged":
		case "RecordingDeclared":
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
		case "RecorderRegistered":
			return HashSet.empty()
		case "RecordAcknowledged":
			return HashSet.fromIterable(
				Option.toArray(
					Option.map(
						HashMap.get(s.records, event.record),
						(duty) => duty.payload.change,
					),
				),
			)
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
			: incoming._tag === "Requested"
				? { ...incoming, request: InputSnapshot.input(incoming.request) }
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
	const appliedEvent = retryPending(apply(prepTimed, event))
	const applied = Arr.reduce(
		appliedEvent.admissions,
		appliedEvent,
		(s, ready) =>
			Preparation.admitResult(
				admittedRestart(submit(s, ready.request), ready.request),
				ready.preparation,
			),
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
	const callSettled =
		event._tag === "CallObserved" ||
		event._tag === "CallExpired" ||
		(event._tag === "Reported" &&
			Option.exists(
				HashMap.get(state.commands, event.command),
				(c) => c.change === "$calls",
			))
			? HashSet.reduce(described.changed, described, (s, id) =>
					withChange(s, id, progressSettlement),
				)
			: described
	const revised = HashSet.reduce(callSettled.changed, callSettled, (s, id) =>
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
