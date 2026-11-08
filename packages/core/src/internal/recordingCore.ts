/** Recording duties: admission checks, gates and acknowledgements as plain data. No runtime handles enter this module. */
import {
	Array as Arr,
	Cause,
	HashMap,
	HashSet,
	Option,
	String as Str,
} from "effect"

import type {
	Change,
	Command,
	GroupPlan,
	Outcome,
	RecordDuty,
	RecordFact,
	RecordingDeclaration,
	RecordingPolicy,
	RecordingSignal,
	RecordingStatus,
	RecordStage,
	Rejection,
	State,
	Unit,
	Working,
} from "./decisionState"

/** Record deliveries are kernel-owned commands that belong to no Change. */
export const commands = "$recording"
/** Records keep at most this much of a rendered cause. */
const diagnosticLimit = 4096
export const stages: ReadonlyArray<RecordStage> = [
	"Intent",
	"Commit",
	"Conclusion",
]

export const policy = (options: RecordingDeclaration): RecordingPolicy => ({
	recorder: options.recorder,
	instance: options.instance,
	scope: HashSet.fromIterable(options.scope),
	maxRecords: Math.max(stages.length, options.maxRecords ?? 64),
})
const same = (a: RecordingPolicy, b: RecordingPolicy): boolean =>
	a.recorder === b.recorder &&
	a.instance === b.instance &&
	a.maxRecords === b.maxRecords &&
	HashSet.size(a.scope) === HashSet.size(b.scope) &&
	HashSet.isSubset(a.scope, b.scope)
/**
 * Sets the recording role when the deployment had none. Declaring the same role again
 * is accepted; a different one is refused, since records already owed would lose their owner.
 */
export const declare = (
	s: Working,
	declaration: RecordingDeclaration,
): Working => {
	const next = policy(declaration)
	return Option.match(s.recording, {
		onNone: () => ({ ...s, recording: Option.some(next) }),
		onSome: (current) =>
			same(current, next)
				? s
				: {
						...s,
						reply: {
							_tag: "Rejected",
							reason: "RecordingConflict",
							conflicts: HashSet.make(current.instance),
						},
					},
	})
}
export const dutyId = (change: string, stage: RecordStage): string =>
	`${change}/${stage}`
/** A Change needs recording when its full closure contains an instance in the policy scope. */
export const required = (s: State, plan: GroupPlan): boolean =>
	Option.exists(s.recording, (p) =>
		HashSet.some(plan.members, (id) => HashSet.has(p.scope, id)),
	)
const outstanding = (s: State): HashMap.HashMap<string, RecordDuty> =>
	HashMap.filter(s.records, (duty) => !duty.acknowledged)
/** A concluded Change gives back the stage slots it never used. */
export const settled = (s: Working, c: Change): Working =>
	c.recorded
		? {
				...s,
				recordsPromised:
					s.recordsPromised -
					Arr.filter(
						stages,
						(stage) => !HashMap.has(s.records, dutyId(c.id, stage)),
					).length,
			}
		: s
const running = (u: Unit): boolean =>
	u.evidence === "Missing" && u.phase === "Running"
/** The grant counts only while its incarnation is live and still hosts the policy instance. */
const liveOwner = (s: State, p: RecordingPolicy): Option.Option<Unit> =>
	Option.flatMap(s.recorder, (grant) =>
		Option.filter(
			HashMap.get(s.units, grant.unit),
			(u) =>
				u.incarnation === grant.incarnation &&
				running(u) &&
				Option.exists(HashMap.get(s.instances, p.instance), (instance) =>
					Option.contains(instance.current, u.id),
				),
		),
	)
export interface Refusal {
	readonly reason: Rejection
	readonly conflicts: HashSet.HashSet<string>
}
/** Checked before a Change id or any stop command exists. */
export const admission = (s: State, plan: GroupPlan): Option.Option<Refusal> =>
	Option.flatMap(s.recording, (p) => {
		const needs = required(s, plan)
		if (
			HashSet.has(plan.members, p.instance) &&
			(needs || s.recordsOutstanding > 0)
		)
			return Option.some({
				reason: "SelfReplacement" as const,
				conflicts: HashSet.make(p.instance),
			})
		if (!needs) return Option.none()
		if (Option.isNone(liveOwner(s, p)))
			return Option.some({
				reason: "RecordingUnavailable" as const,
				conflicts: HashSet.make(p.instance),
			})
		return s.recordsOutstanding + s.recordsPromised + stages.length >
			p.maxRecords
			? Option.some({
					reason: "RecordingCapacity" as const,
					conflicts: HashSet.make(p.instance),
				})
			: Option.none()
	})
/** Length-prefixed parts give an unambiguous content identity without a serializer. */
const part = (value: string): string => `${value.length}:${value}`
const content = (duty: Omit<RecordDuty, "content">): string =>
	Arr.join(
		Arr.map(
			[
				duty.recorder,
				duty.payload.change,
				duty.payload.stage,
				Arr.join(Arr.map(duty.payload.members, part), ""),
				Arr.join(Arr.map(duty.payload.targets, part), ""),
				Option.getOrElse(duty.payload.outcome, () => ""),
				Arr.join(
					Arr.map(duty.payload.facts, (fact) =>
						Arr.join(
							Arr.map(
								[
									fact.instance,
									Option.getOrElse(fact.desired, () => ""),
									Option.getOrElse(fact.actual, () => ""),
									fact.healthy ? "healthy" : "unhealthy",
									fact.attempt,
								],
								part,
							),
							"",
						),
					),
					"",
				),
				duty.payload.phase,
				duty.payload.diagnostic,
			],
			part,
		),
		"",
	)
const delivery = (s: State, duty: RecordDuty): Command => ({
	subjects: HashSet.make(duty.payload.change),
	placement: { kind: "Worker" },
	resolutions: HashMap.empty(),
	descriptions: HashMap.empty(),
	policies: HashMap.empty(),
	members: HashMap.empty(),
	dispatched: true,
	record: duty,
	id: `${commands}/${duty.id}/${duty.deliveries}`,
	change: commands,
	kind: "Record",
	token: {
		authority: s.authority,
		change: duty.payload.change,
		unit: duty.unit,
		incarnation: duty.incarnation,
		members: HashMap.empty(),
		view: duty.deliveries,
	},
	unit: duty.unit,
	target: { identity: duty.recorder, placement: "Worker", overlap: false },
	participant: "",
	timer: Option.none(),
	status: Option.none(),
	disposition: "Pending",
	report: Option.none(),
})
const deliver = (s: Working, duty: RecordDuty): Working => {
	const command = delivery(s, duty)
	return {
		...s,
		records: HashMap.set(s.records, duty.id, duty),
		commands: HashMap.set(s.commands, command.id, command),
		emitted: Arr.append(s.emitted, command),
	}
}
/** Creates the stage duty once, bound to the current grant; a missing grant leaves it blocked. */
export const request = (
	s: Working,
	c: Change,
	stage: RecordStage,
	outcome: Option.Option<Outcome>,
	facts: ReadonlyArray<RecordFact>,
): Working => {
	const id = dutyId(c.id, stage)
	if (HashMap.has(s.records, id)) return s
	const grant = Option.flatMap(s.recording, (p) =>
		Option.flatMap(liveOwner(s, p), (u) =>
			Option.map(s.recorder, (g) => ({ ...g, unit: u.id })),
		),
	)
	const draft: Omit<RecordDuty, "content"> = {
		id,
		recorder: Option.match(s.recording, {
			onNone: () => "",
			onSome: (p) => p.recorder,
		}),
		unit: Option.match(grant, { onNone: () => "", onSome: (g) => g.unit }),
		incarnation: Option.match(grant, {
			onNone: () => "",
			onSome: (g) => g.incarnation,
		}),
		payload: {
			run: s.run,
			change: c.id,
			stage,
			members: Arr.sort(Arr.fromIterable(c.plan.members), stringOrder),
			targets: Arr.sort(
				Arr.map(
					Arr.fromIterable(HashMap.values(c.plan.desired)),
					(m) => `${m.instance}=${m.target.identity}`,
				),
				stringOrder,
			),
			outcome,
			facts,
			phase: Option.match(c.conclusion, {
				onNone: () => c.phase,
				onSome: (conclusion) => conclusion.phase,
			}),
			diagnostic:
				Cause.hasFails(c.cause) ||
				Cause.hasDies(c.cause) ||
				Cause.hasInterrupts(c.cause)
					? Str.slice(0, diagnosticLimit)(Cause.pretty(c.cause))
					: "",
		},
		deliveries: 0,
		acknowledged: false,
	}
	const duty: RecordDuty = { ...draft, content: content(draft) }
	const counted: Working = {
		...s,
		recordsOutstanding: s.recordsOutstanding + 1,
		recordsPromised: s.recordsPromised - 1,
	}
	return duty.unit === ""
		? { ...counted, records: HashMap.set(s.records, duty.id, duty) }
		: deliver(counted, duty)
}
const stringOrder = (a: string, b: string): -1 | 0 | 1 =>
	a < b ? -1 : a > b ? 1 : 0
export const acknowledged = (
	s: State,
	change: string,
	stage: RecordStage,
): boolean =>
	Option.exists(
		HashMap.get(s.records, dutyId(change, stage)),
		(d) => d.acknowledged,
	)
/** A unit hosting the policy instance may register while it starts; the grant counts once that unit is current. Registration replays the incarnation's own outstanding records. */
export const register = (
	s: Working,
	signal: Extract<RecordingSignal, { readonly _tag: "RecorderRegistered" }>,
): Working => {
	const accepted = Option.exists(
		s.recording,
		(p) =>
			p.recorder === signal.recorder &&
			Option.exists(
				HashMap.get(s.units, signal.unit),
				(u) =>
					u.incarnation === signal.incarnation &&
					u.evidence === "Missing" &&
					HashMap.has(u.members, p.instance),
			),
	)
	if (!accepted)
		return {
			...s,
			reply: {
				_tag: "Rejected",
				reason: "Unauthorized",
				conflicts: HashSet.make(signal.recorder),
			},
		}
	const granted: Working = {
		...s,
		recorder: Option.some({
			recorder: signal.recorder,
			unit: signal.unit,
			incarnation: signal.incarnation,
		}),
	}
	return HashMap.reduce(outstanding(granted), granted, (next, duty) =>
		duty.unit === signal.unit && duty.incarnation === signal.incarnation
			? deliver(next, { ...duty, deliveries: duty.deliveries + 1 })
			: next,
	)
}
export type Acknowledgement =
	| { readonly _tag: "Rejected" }
	| { readonly _tag: "Repeated" }
	| { readonly _tag: "Discharged"; readonly duty: RecordDuty }
/** Only the live owner incarnation that received the duty can discharge it, with identical content. */
export const acknowledge = (
	s: State,
	signal: Extract<RecordingSignal, { readonly _tag: "RecordAcknowledged" }>,
): Acknowledgement =>
	Option.match(HashMap.get(s.records, signal.record), {
		onNone: () => ({ _tag: "Rejected" }),
		onSome: (duty) =>
			duty.unit !== signal.unit ||
			duty.incarnation !== signal.incarnation ||
			duty.content !== signal.content ||
			!Option.exists(HashMap.get(s.units, duty.unit), running)
				? { _tag: "Rejected" }
				: duty.acknowledged
					? { _tag: "Repeated" }
					: { _tag: "Discharged", duty: { ...duty, acknowledged: true } },
	})
export const status = (s: State, c: Change): RecordingStatus => {
	const pending = Arr.flatMap(stages, (stage) =>
		Option.toArray(
			Option.filter(
				HashMap.get(s.records, dutyId(c.id, stage)),
				(duty) => !duty.acknowledged,
			),
		),
	)
	return {
		required: c.recorded,
		gate: c.recordingGate,
		outstanding: pending,
		blocked: Arr.some(
			pending,
			(duty) =>
				!Option.exists(
					s.recorder,
					(g) => g.unit === duty.unit && g.incarnation === duty.incarnation,
				) || !Option.exists(HashMap.get(s.units, duty.unit), running),
		),
	}
}
