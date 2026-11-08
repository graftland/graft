import { Array, Cause, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import { exit, fire, report, request } from "./change-model/scenarios"
import { declaredMembers, rootRealms } from "./member-fact"

const declaration = (
	id: string,
	patch: Partial<Core.MemberDeclaration> = {},
): Core.MemberDeclaration => ({
	...Option.getOrThrow(
		Array.head(
			declaredMembers([
				{ id, target: { identity: id, placement: "Worker", overlap: true } },
			]),
		),
	),
	placement: Option.none(),
	...patch,
})
const initial = (
	options: {
		readonly maxRecords?: number
		readonly declarations?: ReadonlyArray<Core.MemberDeclaration>
	} = {},
) =>
	Core.make({
		authority: "recorded",
		maxUnits: 8,
		declarations: options.declarations ?? [
			declaration("release"),
			declaration("a"),
			declaration("c"),
		],
		realms: rootRealms,
		recording: {
			recorder: "release",
			instance: "release",
			scope: ["a", "b"],
			...(options.maxRecords === undefined
				? {}
				: { maxRecords: options.maxRecords }),
		},
	})
const unitOf = (s: Core.State, instance: string): Core.Unit =>
	Option.getOrThrow(
		Option.flatMap(
			Option.flatMap(HashMap.get(s.instances, instance), (i) => i.current),
			(id) => HashMap.get(s.units, id),
		),
	)
const register = (s: Core.State, unit = unitOf(s, "release")) =>
	Core.reduce(s, {
		_tag: "RecorderRegistered",
		unit: unit.id,
		incarnation: unit.incarnation,
		recorder: "release",
		now: s.now,
	})
const submit = (
	s: Core.State,
	instance = "a",
	strategy: Core.Strategy = "Restart",
) =>
	Core.reduce(s, {
		_tag: "Submit",
		now: s.now,
		request: {
			...request(s, instance, strategy),
			proposal: {
				members: [
					declaration(instance, {
						target: {
							identity: `${instance}-next`,
							placement: "Worker",
							overlap: true,
						},
					}),
				],
				explicit: HashSet.make(instance),
				removed: HashSet.empty(),
				realms: [],
			},
		},
	})
const duty = (s: Core.State, change: string, stage: Core.RecordStage) =>
	Option.getOrThrow(HashMap.get(s.records, `${change}/${stage}`))
const acknowledge = (
	s: Core.State,
	d: Core.RecordDuty,
	patch: Partial<{ unit: string; incarnation: string; content: string }> = {},
) =>
	Core.reduce(s, {
		_tag: "RecordAcknowledged",
		unit: patch.unit ?? d.unit,
		incarnation: patch.incarnation ?? d.incarnation,
		record: d.id,
		content: patch.content ?? d.content,
		now: s.now,
	})
/** The incrementally kept counters equal a full recount of records and promised stages. */
const counted = (s: Core.State) => {
	const outstanding = Array.filter(
		Array.fromIterable(HashMap.values(s.records)),
		(d) => !d.acknowledged,
	).length
	const promised = Array.reduce(
		Array.fromIterable(HashMap.values(s.changes)),
		0,
		(total, c) =>
			c.recorded && Option.isNone(c.conclusion)
				? total +
					Array.filter(
						["Intent", "Commit", "Conclusion"] as const,
						(stage) => !HashMap.has(s.records, `${c.id}/${stage}`),
					).length
				: total,
	)
	assert.deepStrictEqual(
		[s.recordsOutstanding, s.recordsPromised],
		[outstanding, promised],
	)
}
const status = (s: Core.State, id = "change-1") => {
	counted(s)
	return Option.getOrThrow(Core.get(s, id))
}
const runtimeKinds = HashSet.fromIterable<Core.CommandKind>([
	"Resolve",
	"Spawn",
	"Start",
	"Serve",
	"Ready",
	"Probe",
	"Install",
	"Activate",
	"Stop",
	"Terminate",
])
/** Returns evidence for production-issued runtime commands until the Change concludes, waits at a gate, or reaches `stopAt`. */
const drive = (s: Core.State, id = "change-1", remaining = 100): Core.State => {
	assert.isAbove(remaining, 0, "The recorded command protocol did not settle")
	const current = status(s, id)
	if (Option.isSome(current.conclusion)) return s
	const change = Option.getOrThrow(HashMap.get(s.changes, id))
	const command = Array.findFirst(
		HashMap.values(s.commands),
		(c) =>
			c.change === id &&
			c.disposition === "Pending" &&
			c.token.view === change.view &&
			HashSet.has(runtimeKinds, c.kind),
	)
	if (Option.isSome(command)) {
		const next = report(s, command.value)
		return drive(
			command.value.kind === "Stop" || command.value.kind === "Terminate"
				? exit(next, command.value.unit, { _tag: "Completed" })
				: next,
			id,
			remaining - 1,
		)
	}
	const trial = Array.findFirst(
		HashMap.values(s.timers),
		(t) => t.change === id && t.purpose === "Trial" && t.active,
	)
	return Option.isSome(trial)
		? drive(fire(s, id, "Trial"), id, remaining - 1)
		: s
}
const issued = (t: Core.Transition, kind: Core.CommandKind) =>
	Array.filter(t.commands, (c) => c.kind === kind)

it("withholds every lifecycle action until the recorder acknowledges the intent (I8, F16)", () => {
	const registered = register(initial()).state
	const admitted = submit(registered)
	assert.equal(admitted.reply._tag, "Admitted")
	const records = issued(admitted, "Record")
	assert.equal(records.length, 1)
	assert.equal(records[0]?.unit, unitOf(registered, "release").id)
	assert.equal(records[0]?.record?.payload.stage, "Intent")
	assert.isFalse(
		Array.some(admitted.commands, (c) => HashSet.has(runtimeKinds, c.kind)),
	)
	assert.isTrue(
		Option.contains(status(admitted.state).recording.gate, "Intent"),
	)
	const started = acknowledge(
		admitted.state,
		duty(admitted.state, "change-1", "Intent"),
	)
	assert.isTrue(issued(started, "Stop").length > 0)
	assert.isTrue(Option.isNone(status(started.state).recording.gate))
})

it("activates no route before an acknowledged commit decision and reports Accepted only after the concluding record (I8, F16)", () => {
	const admitted = submit(register(initial()).state).state
	const intent = acknowledge(admitted, duty(admitted, "change-1", "Intent"))
	const atCommit = drive(intent.state)
	assert.isTrue(Option.contains(status(atCommit).recording.gate, "Commit"))
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(atCommit.commands)),
			(c) => c.change === "change-1" && c.kind === "Activate",
		),
	)
	const committed = acknowledge(atCommit, duty(atCommit, "change-1", "Commit"))
	assert.isTrue(issued(committed, "Activate").length > 0)
	const atConclusion = drive(committed.state)
	const blocked = status(atConclusion)
	assert.isTrue(Option.contains(blocked.recording.gate, "Conclusion"))
	assert.isTrue(Option.isNone(blocked.conclusion))
	const fact = Option.getOrThrow(HashMap.get(blocked.members, "a"))
	assert.isTrue(fact.healthy && fact.matchesTarget)
	const cancelled = Core.reduce(atConclusion, {
		_tag: "Cancel",
		change: "change-1",
		cause: Cause.fail("A late cancellation cannot undo finished execution"),
		now: atConclusion.now,
	})
	assert.isTrue(Option.isNone(status(cancelled.state).conclusion))
	assert.isFalse(
		Array.some(cancelled.commands, (c) => HashSet.has(runtimeKinds, c.kind)),
	)
	const done = acknowledge(
		atConclusion,
		duty(atConclusion, "change-1", "Conclusion"),
	).state
	assert.equal(Option.getOrThrow(status(done).conclusion).outcome, "Accepted")
	assert.equal(status(done).recording.outstanding.length, 0)
})

it("rejects work that needs a recorder before any Change id exists when no live recorder is registered (F16)", () => {
	const s = initial()
	const result = submit(s)
	assert.equal(result.reply._tag, "Rejected")
	assert.equal(
		result.reply._tag === "Rejected" ? result.reply.reason : "",
		"RecordingUnavailable",
	)
	assert.equal(result.state.nextChange, s.nextChange)
	assert.equal(result.commands.length, 0)
	const unrelated = submit(s, "c")
	assert.equal(unrelated.reply._tag, "Admitted")
})

it("keeps a commit-blocked Change unactivated and its duty explicit after the recorder dies, rejecting a new incarnation's acknowledgement (I8, F16, F18)", () => {
	const registered = register(initial()).state
	const recorder = unitOf(registered, "release")
	const admitted = submit(registered).state
	const atCommit = drive(
		acknowledge(admitted, duty(admitted, "change-1", "Intent")).state,
	)
	const crashed = exit(atCommit, recorder.id, { _tag: "Completed" })
	const blocked = status(crashed)
	assert.isTrue(blocked.recording.blocked)
	assert.isTrue(Option.contains(blocked.recording.gate, "Commit"))
	const pending = duty(crashed, "change-1", "Commit")
	const stale = acknowledge(crashed, pending)
	assert.equal(stale.reply._tag, "Rejected")
	const impostor = acknowledge(crashed, pending, {
		incarnation: `${recorder.incarnation}/next`,
	})
	assert.equal(impostor.reply._tag, "Rejected")
	assert.isFalse(duty(impostor.state, "change-1", "Commit").acknowledged)
	const expired = drive(
		fire({ ...crashed, now: crashed.now + 2000 }, "change-1", "Total"),
	)
	const concluded = Option.getOrThrow(status(expired).conclusion)
	assert.notEqual(concluded.outcome, "Accepted")
	const forwardView = Option.getOrThrow(
		HashMap.get(atCommit.changes, "change-1"),
	).view
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(expired.commands)),
			(c) =>
				c.change === "change-1" &&
				c.kind === "Activate" &&
				c.token.view === forwardView,
		),
	)
	assert.isTrue(
		Array.some(
			status(expired).recording.outstanding,
			(d) => d.payload.stage === "Commit",
		),
	)
})

it("replays a stored record to the same live owner after a lost acknowledgement and discharges it exactly once (F17)", () => {
	const registered = register(initial()).state
	const admitted = submit(registered).state
	const replayed = register(admitted)
	const again = issued(replayed, "Record")
	assert.equal(again.length, 1)
	assert.equal(again[0]?.record?.id, "change-1/Intent")
	assert.equal(again[0]?.record?.deliveries, 1)
	const intent = duty(replayed.state, "change-1", "Intent")
	const wrong = acknowledge(replayed.state, intent, { content: "other" })
	assert.equal(wrong.reply._tag, "Rejected")
	const first = acknowledge(replayed.state, intent)
	assert.isTrue(issued(first, "Stop").length > 0)
	const second = acknowledge(first.state, intent)
	assert.equal(second.commands.length, 0)
	assert.equal(second.reply._tag, "None")
	assert.equal(HashMap.size(first.state.changes), 1)
})

it("rejects direct and indirect self-replacement before admission, without a first-party exemption (I9, F19)", () => {
	const registered = register(
		initial({
			declarations: [
				declaration("release", { colocate: ["control"] }),
				declaration("b", { colocate: ["control"] }),
				declaration("a"),
				declaration("c"),
			],
		}),
	).state
	const indirect = submit(registered, "b")
	assert.equal(
		indirect.reply._tag === "Rejected" ? indirect.reply.reason : "",
		"SelfReplacement",
	)
	assert.equal(indirect.state.nextChange, registered.nextChange)
	assert.equal(issued(indirect, "Stop").length, 0)
	const holding = submit(registered).state
	const direct = submit(holding, "release")
	assert.equal(
		direct.reply._tag === "Rejected" ? direct.reply.reason : "",
		"SelfReplacement",
	)
	const plain = register(initial()).state
	const ordinary = submit(plain, "release")
	assert.equal(ordinary.reply._tag, "Admitted")
})

it("reserves bounded record capacity and rejects excess work rather than evicting a duty (F16)", () => {
	const registered = register(initial({ maxRecords: 3 })).state
	const first = submit(registered).state
	const second = submit(first, "b")
	assert.equal(
		second.reply._tag === "Rejected" ? second.reply.reason : "",
		"RecordingCapacity",
	)
	assert.isTrue(HashMap.has(second.state.records, "change-1/Intent"))
})

it("never reports success when shutdown arrives while the concluding record is missing (F22)", () => {
	const admitted = submit(register(initial()).state).state
	const atCommit = drive(
		acknowledge(admitted, duty(admitted, "change-1", "Intent")).state,
	)
	const atConclusion = drive(
		acknowledge(atCommit, duty(atCommit, "change-1", "Commit")).state,
	)
	const closed = Core.reduce(atConclusion, {
		_tag: "Shutdown",
		now: atConclusion.now,
	}).state
	assert.isFalse(
		Option.exists(status(closed).conclusion, (c) => c.outcome === "Accepted"),
	)
	assert.isTrue(
		Array.some(
			status(closed).recording.outstanding,
			(d) => d.payload.stage === "Conclusion",
		),
	)
})

const atConclusionGate = () => {
	const admitted = submit(register(initial()).state).state
	const atCommit = drive(
		acknowledge(admitted, duty(admitted, "change-1", "Intent")).state,
	)
	return drive(
		acknowledge(atCommit, duty(atCommit, "change-1", "Commit")).state,
	)
}

it("concludes with the facts of finished execution and hands a later exit to the supervisor (I8, C8)", () => {
	const gated = atConclusionGate()
	const serving = unitOf(gated, "a")
	const crashed = Core.reduce(gated, {
		_tag: "Exited",
		unit: serving.id,
		incarnation: serving.incarnation,
		observer: serving.spawn,
		cleanup: { _tag: "Unknown" },
		cause: Cause.fail("Crashed after execution finished"),
		now: gated.now,
	}).state
	assert.equal(HashMap.size(crashed.pendingRestarts), 1)
	const done = acknowledge(crashed, duty(crashed, "change-1", "Conclusion"))
	const conclusion = Option.getOrThrow(status(done.state).conclusion)
	assert.equal(conclusion.outcome, "Accepted")
	assert.isTrue(Option.getOrThrow(HashMap.get(conclusion.members, "a")).healthy)
	// The deferred restart is taken up once the Change releases its instances. This
	// fixture's targets carry no deployment data, so the supervisor escalates.
	assert.equal(HashMap.size(done.state.pendingRestarts), 0)
	assert.isTrue(
		Option.exists(HashMap.get(done.state.supervision, "a"), (f) => f.escalated),
	)
})

it("lets the kernel finish shutting down while a concluding record can no longer be acknowledged (F22)", () => {
	const gated = atConclusionGate()
	const closed = Core.reduce(gated, { _tag: "Shutdown", now: gated.now }).state
	const ended = Array.reduce(
		Array.fromIterable(HashMap.values(closed.units)),
		closed,
		(s, u) =>
			u.evidence === "Missing"
				? Core.reduce(s, {
						_tag: "Exited",
						unit: u.id,
						incarnation: u.incarnation,
						observer: u.spawn,
						cleanup: { _tag: "Completed" },
						cause: Cause.empty,
						now: s.now,
					}).state
				: s,
	)
	const current = status(ended)
	assert.isTrue(Option.isNone(current.conclusion))
	assert.isTrue(current.recording.blocked)
})
