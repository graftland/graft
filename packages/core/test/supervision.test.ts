import { Array, Cause, HashMap, HashSet, Option, String } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import * as Executions from "../src/internal/executionState"
import { report, request } from "./change-model/scenarios"
import { declaredMembers, rootRealms } from "./member-fact"
import * as Prepared from "./preparation-fixture"
import { target } from "./preparation-fixture"

const initial = (supervision?: Core.SupervisionDeclaration) =>
	Core.make({
		authority: "supervision",
		maxUnits: 4,
		declarations: Array.map(
			declaredMembers([{ id: "a", target: target("a") }]),
			(member) => ({ ...member, placement: Option.none() }),
		),
		realms: rootRealms,
		...(supervision === undefined ? {} : { supervision }),
	})
const signal = (
	state: Core.State,
	tag: "MemberFailed" | "MemberStopped",
	instance = "a",
): Core.Transition => {
	const current = Option.getOrThrow(Executions.current(state, instance))
	const identity = {
		unit: current.unit.id,
		incarnation: current.unit.incarnation,
		observer: current.unit.spawn,
		member: instance,
		term: current.member.term,
		generation: current.member.generation,
		now: state.now,
	}
	return Core.reduce(
		state,
		tag === "MemberFailed"
			? { ...identity, _tag: tag, cause: Cause.fail("Ordinary member failure") }
			: {
					...identity,
					_tag: tag,
					cleanup: { _tag: "Completed" },
					cause: Cause.empty,
				},
	)
}
/** Returns evidence for every pending member-operation command until none is left. */
const settle = (state: Core.State, remaining = 50): Core.State => {
	assert.isAbove(remaining, 0, "The member operation did not settle")
	const pending = Array.findFirst(
		HashMap.values(state.commands),
		(c) =>
			c.disposition === "Pending" &&
			String.startsWith("member-operation-")(c.change) &&
			c.kind !== "ArmTimer" &&
			c.kind !== "CancelTimer" &&
			c.kind !== "Publish",
	)
	if (Option.isNone(pending)) return state
	const command = pending.value
	if (command.kind === "StopMembers") {
		const stopped = Option.exists(
			Executions.current(state, "a"),
			({ member }) => member.phase === "Stopped",
		)
		return settle(
			report(stopped ? state : signal(state, "MemberStopped").state, command),
			remaining - 1,
		)
	}
	return settle(
		report(
			state,
			command,
			command.kind === "Resolve"
				? {
						_tag: "Resolved",
						value: { input: {}, identity: "fresh", environment: "test" },
					}
				: undefined,
		),
		remaining - 1,
	)
}
const restarts = (t: Core.Transition) =>
	Array.filter(t.commands, (c) => c.kind === "StopMembers").length
const fact = (state: Core.State) =>
	Option.getOrElse(HashMap.get(state.supervision, "a"), () => ({
		attempts: [],
		escalated: false,
	}))
const at = (state: Core.State, now: number): Core.State => ({ ...state, now })

it("restarts a failed member within the restart intensity, then escalates and only stops it (C8)", () => {
	const first = signal(
		initial({ intensity: 2, period: 60_000 }),
		"MemberFailed",
	)
	assert.equal(restarts(first), 1)
	const once = settle(first.state)
	assert.isTrue(Executions.healthy(once, "a"))
	const second = signal(at(once, 10), "MemberFailed")
	assert.equal(restarts(second), 1)
	const twice = settle(second.state)
	assert.isTrue(Executions.healthy(twice, "a"))
	assert.equal(fact(twice).attempts.length, 2)
	const third = signal(at(twice, 20), "MemberFailed")
	const stopped = settle(third.state)
	assert.isTrue(fact(stopped).escalated)
	assert.isFalse(Executions.healthy(stopped, "a"))
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(stopped.commands)),
			(c) => c.kind === "RestartMembers" && c.disposition === "Pending",
		),
	)
	assert.equal(HashMap.size(stopped.changes), 0)
})

it("counts only attempts inside the period and keeps them across generations (C8)", () => {
	const once = settle(
		signal(initial({ intensity: 1, period: 1_000 }), "MemberFailed").state,
	)
	const term = Option.getOrThrow(Executions.current(once, "a")).member.term
	assert.isAbove(term, 0)
	const soon = settle(signal(at(once, 500), "MemberFailed").state)
	assert.isTrue(fact(soon).escalated)
	const later = settle(
		signal(
			at(
				settle(
					signal(initial({ intensity: 1, period: 1_000 }), "MemberFailed")
						.state,
				),
				5_000,
			),
			"MemberFailed",
		).state,
	)
	assert.isFalse(fact(later).escalated)
	assert.isTrue(Executions.healthy(later, "a"))
})

it("redeploys a crashed unit through one ordinary supervisor request, and escalates instead once exhausted (C8)", () => {
	const state = initial({ intensity: 1, period: 60_000 })
	const unit = Option.getOrThrow(HashMap.get(state.units, "a@0"))
	const crash = (s: Core.State, u: Core.Unit) =>
		Core.reduce(s, {
			_tag: "Exited",
			unit: u.id,
			incarnation: u.incarnation,
			observer: u.spawn,
			cleanup: { _tag: "Unknown" },
			cause: Cause.fail("Native crash"),
			now: s.now,
		})
	const crashed = crash(state, unit)
	assert.equal(HashMap.size(crashed.state.preparations), 1)
	assert.equal(fact(crashed.state).attempts.length, 1)
	const exhausted = crash(
		{
			...state,
			supervision: HashMap.make(["a", { attempts: [0], escalated: false }]),
		},
		unit,
	)
	assert.equal(HashMap.size(exhausted.state.preparations), 0)
	assert.isTrue(fact(exhausted.state).escalated)
})

it("starts no supervisor attempt during kernel shutdown (C8)", () => {
	const state = initial()
	const closed = Core.reduce(state, { _tag: "Shutdown", now: 0 }).state
	const unit = Option.getOrThrow(HashMap.get(closed.units, "a@0"))
	const exited = Core.reduce(closed, {
		_tag: "Exited",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		cleanup: { _tag: "Completed" },
		cause: Cause.empty,
		now: 0,
	}).state
	assert.equal(HashMap.size(exited.preparations), 0)
	assert.equal(fact(exited).attempts.length, 0)
})

const revoke = (state: Core.State): Core.State =>
	Core.reduce(state, {
		_tag: "PolicyChanged",
		instance: "a",
		allowed: ["another-identity"],
		values: {},
		now: state.now,
	}).state

it("does not restart a member whose target the operator revoked (C7, C8)", () => {
	const failed = signal(revoke(initial()), "MemberFailed")
	const after = settle(failed.state)
	assert.isFalse(Executions.healthy(after, "a"))
	assert.equal(fact(after).attempts.length, 0)
})

it("does not redeploy a crashed unit with a revoked target (C7, C8)", () => {
	const state = revoke(initial())
	const unit = Option.getOrThrow(HashMap.get(state.units, "a@0"))
	const crashed = Core.reduce(state, {
		_tag: "Exited",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		cleanup: { _tag: "Unknown" },
		cause: Cause.fail("Native crash"),
		now: state.now,
	}).state
	assert.equal(HashMap.size(crashed.preparations), 0)
	assert.equal(fact(crashed).attempts.length, 0)
	assert.isFalse(Executions.healthy(crashed, "a"))
})

it("keeps a revocation when only reference values change afterwards (C7)", () => {
	const revoked = revoke(initial())
	const refreshed = Core.reduce(revoked, {
		_tag: "PolicyChanged",
		instance: "a",
		values: { TOKEN: "rotated" },
		now: revoked.now,
	}).state
	const after = settle(signal(refreshed, "MemberFailed").state)
	assert.isFalse(Executions.healthy(after, "a"))
	assert.equal(fact(after).attempts.length, 0)
})

it("defers a supervisor restart that admission finds busy and does not count it (C8)", () => {
	const state = initial({ intensity: 1, period: 60_000 })
	const unit = Option.getOrThrow(HashMap.get(state.units, "a@0"))
	const crashed = Core.reduce(state, {
		_tag: "Exited",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		cleanup: { _tag: "Unknown" },
		cause: Cause.fail("Native crash"),
		now: state.now,
	})
	assert.equal(crashed.reply._tag, "None")
	const supervisor = Option.getOrThrow(
		Array.head(Array.fromIterable(HashMap.keys(crashed.state.preparations))),
	)
	// An operator Change for the same instance is admitted first.
	const operator = Prepared.prepare(crashed.state, Prepared.input())
	const q = Prepared.id(operator)
	const admitted = Prepared.exit(Prepared.described(operator.state, q), q)
	assert.equal(admitted.reply._tag, "Admitted")
	const busy = Prepared.exit(
		Prepared.described(
			admitted.state,
			supervisor,
			Prepared.description(target("a"), "a"),
		),
		supervisor,
	)
	assert.equal(busy.reply._tag, "Rejected")
	assert.equal(HashMap.size(busy.state.pendingRestarts), 1)
	assert.equal(fact(busy.state).attempts.length, 0)
	assert.isFalse(fact(busy.state).escalated)
})

it("restarts the authorized members of a unit while a revoked co-member stays stopped (C7, C8)", () => {
	const pair = Core.make({
		authority: "supervision",
		maxUnits: 4,
		declarations: Array.map(
			declaredMembers([
				{ id: "a", target: target("a") },
				{ id: "b", target: target("b") },
			]),
			(member) => ({
				...member,
				placement: Option.none(),
				...(member.instance === "a"
					? { localProvides: ["ab"] }
					: { localRequires: [{ key: "ab", optional: false }] }),
			}),
		),
		realms: rootRealms,
	})
	const revoked = Core.reduce(pair, {
		_tag: "PolicyChanged",
		instance: "b",
		allowed: ["another-identity"],
		values: {},
		now: pair.now,
	}).state
	const stopAll = (state: Core.State, members: Iterable<string>): Core.State =>
		Array.reduce(Array.fromIterable(members), state, (s, id) =>
			Option.match(Executions.current(s, id), {
				onNone: () => s,
				onSome: ({ unit, member }) =>
					member.phase === "Stopped" || member.phase === "NotStarted"
						? s
						: Core.reduce(s, {
								_tag: "MemberStopped",
								unit: unit.id,
								incarnation: unit.incarnation,
								observer: unit.spawn,
								member: id,
								term: member.term,
								generation: member.generation,
								cleanup: { _tag: "Completed" },
								cause: Cause.empty,
								now: s.now,
							}).state,
			}),
		)
	const drive = (state: Core.State, remaining = 50): Core.State => {
		assert.isAbove(remaining, 0, "The member operation did not settle")
		const command = Array.findFirst(
			HashMap.values(state.commands),
			(c) =>
				c.disposition === "Pending" &&
				String.startsWith("member-operation-")(c.change) &&
				c.kind !== "ArmTimer" &&
				c.kind !== "CancelTimer" &&
				c.kind !== "Publish",
		)
		if (Option.isNone(command)) return state
		const c = command.value
		return drive(
			c.kind === "StopMembers"
				? report(stopAll(state, c.subjects), c)
				: report(
						state,
						c,
						c.kind === "Resolve"
							? {
									_tag: "Resolved",
									value: { input: {}, identity: "fresh", environment: "test" },
								}
							: undefined,
					),
			remaining - 1,
		)
	}
	const current = Option.getOrThrow(Executions.current(revoked, "a"))
	const failed = Core.reduce(revoked, {
		_tag: "MemberFailed",
		unit: current.unit.id,
		incarnation: current.unit.incarnation,
		observer: current.unit.spawn,
		member: "a",
		term: current.member.term,
		generation: current.member.generation,
		cause: Cause.fail("Ordinary member failure"),
		now: revoked.now,
	}).state
	const after = drive(failed)
	assert.isTrue(Executions.healthy(after, "a"))
	assert.isFalse(Executions.healthy(after, "b"))
})

const backoff = { initial: 100, factor: 2, max: 250 }
const restartTimer = (s: Core.State): Core.Timer =>
	Option.getOrThrow(
		Array.findFirst(
			HashMap.values(s.timers),
			(t) => t.purpose === "Restart" && t.active,
		),
	)
const fireRestart = (
	s: Core.State,
	t = restartTimer(s),
	now = t.deadline,
	generation = t.generation,
): Core.Transition =>
	Core.reduce(s, { _tag: "TimerFired", timer: t.id, generation, now })
const downReason = (s: Core.State, instance = "a") =>
	Option.getOrThrow(
		Array.findFirst(Core.supervision(s), (f) => f.instance === instance),
	).reason
const crash = (s: Core.State): Core.Transition => {
	const { unit } = Option.getOrThrow(Executions.current(s, "a"))
	return Core.reduce(s, {
		_tag: "Exited",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		cleanup: { _tag: "Unknown" },
		cause: Cause.fail("Native crash"),
		now: s.now,
	})
}

it("waits for the matching due timer before starting a member restart and caps consecutive backoff (C8)", () => {
	const failed = signal(
		initial({ intensity: 5, period: 50, backoff }),
		"MemberFailed",
	)
	assert.equal(restarts(failed), 0)
	assert.equal(fact(failed.state).attempts.length, 0)
	assert.isTrue(Option.contains(downReason(failed.state), "RestartPending"))
	const first = restartTimer(failed.state)
	assert.equal(first.deadline, 100)
	const early = fireRestart(failed.state, first, 99)
	assert.equal(restarts(early), 0)
	const stale = fireRestart(early.state, first, 100, first.generation + 1)
	assert.equal(restarts(stale), 0)
	assert.equal(fact(stale.state).attempts.length, 0)
	const due = fireRestart(stale.state, first)
	assert.equal(restarts(due), 1)
	assert.deepEqual(fact(due.state).attempts, [100])
	const duplicate = fireRestart(due.state, first)
	assert.equal(restarts(duplicate), 0)
	const second = signal(settle(duplicate.state), "MemberFailed")
	assert.equal(restartTimer(second.state).deadline, 300)
	const third = signal(settle(fireRestart(second.state).state), "MemberFailed")
	assert.equal(restartTimer(third.state).deadline, 550)
})

it("uses a timer for a crashed unit and counts its attempt only after the timer fires (C8)", () => {
	const failed = crash(initial({ backoff }))
	assert.equal(HashMap.size(failed.state.preparations), 0)
	assert.equal(fact(failed.state).attempts.length, 0)
	assert.isTrue(Option.contains(downReason(failed.state), "RestartPending"))
	const due = fireRestart(failed.state)
	assert.equal(HashMap.size(due.state.preparations), 1)
	assert.deepEqual(fact(due.state).attempts, [100])
	assert.isTrue(Option.contains(downReason(due.state), "RestartPending"))
})

it("does not infer a fired timer from elapsed event time or consume intensity while waiting (C8)", () => {
	const failed = signal(
		initial({ intensity: 1, period: 50, backoff }),
		"MemberFailed",
	)
	const advanced = Core.reduce(failed.state, {
		_tag: "PolicyChanged",
		instance: "a",
		values: {},
		now: 1000,
	})
	assert.equal(restarts(advanced), 0)
	assert.equal(fact(advanced.state).attempts.length, 0)
	assert.isFalse(fact(advanced.state).escalated)
	const once = settle(fireRestart(advanced.state).state)
	assert.deepEqual(fact(once).attempts, [1000])
	const exhausted = signal(once, "MemberFailed")
	assert.isTrue(fact(exhausted.state).escalated)
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(exhausted.state.timers)),
			(t) => t.active && t.purpose === "Restart",
		),
	)
	assert.isTrue(
		Option.contains(downReason(settle(exhausted.state)), "Escalated"),
	)
})

it("keeps a fired backoff across busy retries and counts the eventual restart once (C8)", () => {
	const base = initial({ intensity: 1, backoff })
	const failed = signal(base, "MemberFailed")
	const busy = {
		...failed.state,
		cells: HashMap.set(failed.state.cells, "a", {
			...Core.cell(base, "a"),
			readers: HashSet.make("reader-change"),
		}),
	}
	const due = fireRestart(busy)
	assert.equal(restarts(due), 0)
	assert.equal(fact(due.state).attempts.length, 0)
	assert.equal(HashMap.size(due.state.pendingRestarts), 1)
	assert.isTrue(Option.contains(downReason(due.state), "RestartPending"))
	const free = {
		...due.state,
		cells: HashMap.set(due.state.cells, "a", {
			...Core.cell(due.state, "a"),
			readers: HashSet.empty<string>(),
		}),
	}
	const retried = Core.reduce(free, {
		_tag: "PolicyChanged",
		instance: "a",
		values: {},
		now: 150,
	})
	assert.equal(restarts(retried), 1)
	assert.deepEqual(fact(retried.state).attempts, [150])
	assert.equal(HashMap.size(retried.state.pendingRestarts), 0)
})

it("resets backoff on an accepted operator Change and cancels its stale pending timer (C8)", () => {
	const once = settle(
		fireRestart(signal(initial({ backoff }), "MemberFailed").state).state,
	)
	const waiting = signal(once, "MemberFailed").state
	const stale = restartTimer(waiting)
	const change = Core.reduce(waiting, {
		_tag: "Submit",
		request: { ...request(waiting, "a", "Restart"), trial: 0 },
		now: waiting.now,
	})
	assert.equal(change.reply._tag, "Admitted")
	// Complete the operator deployment with the same deterministic command evidence used by Change tests.
	const done = completeChange(change.state)
	assert.equal(
		Option.getOrThrow(Core.get(done, "change-1")).conclusion.pipe(
			Option.getOrThrow,
		).outcome,
		"Accepted",
	)
	assert.equal(HashMap.size(done.pendingRestarts), 0)
	assert.isFalse(Option.getOrThrow(HashMap.get(done.timers, stale.id)).active)
	const late = fireRestart(done, stale, done.now + 1)
	assert.equal(restarts(late), 0)
	const failed = signal(late.state, "MemberFailed")
	assert.equal(restartTimer(failed.state).deadline - failed.state.now, 100)
	assert.equal(fact(failed.state).attempts.length, 1)
})

/** Completes one Restart Change, including native exit evidence for old units. */
const completeChange = (s: Core.State, remaining = 100): Core.State => {
	assert.isAbove(remaining, 0, "The Change did not settle")
	const status = Core.get(s, "change-1")
	if (Option.exists(status, (c) => Option.isSome(c.conclusion))) return s
	const pendingCommand = Array.findFirst(
		HashMap.values(s.commands),
		(c) =>
			c.change === "change-1" &&
			c.disposition === "Pending" &&
			c.kind !== "ArmTimer" &&
			c.kind !== "CancelTimer" &&
			c.kind !== "Publish",
	)
	if (Option.isNone(pendingCommand)) {
		const trial = Prepared.timer(s, "change-1", "Trial")
		return completeChange(
			Core.reduce(s, {
				_tag: "TimerFired",
				timer: trial.id,
				generation: trial.generation,
				now: trial.deadline,
			}).state,
			remaining - 1,
		)
	}
	const pending = pendingCommand.value
	let next = report(s, pending)
	if (pending.kind === "Stop" || pending.kind === "Terminate") {
		const u = Option.getOrThrow(HashMap.get(next.units, pending.unit))
		next = Core.reduce(next, {
			_tag: "Exited",
			unit: u.id,
			incarnation: u.incarnation,
			observer: u.spawn,
			cleanup: { _tag: "Completed" },
			cause: Cause.empty,
			now: next.now,
		}).state
	}
	return completeChange(next, remaining - 1)
}

it("keeps backoff progression when a supervisor Change succeeds (C8)", () => {
	const failed = crash(initial({ backoff })).state
	const due = fireRestart(failed).state
	const q = Option.getOrThrow(
		Array.head(Array.fromIterable(HashMap.keys(due.preparations))),
	)
	const admitted = Prepared.exit(
		Prepared.described(due, q, Prepared.description(target("a"))),
		q,
	)
	assert.equal(admitted.reply._tag, "Admitted")
	const done = completeChange(admitted.state)
	const failedAgain = crash(done).state
	assert.equal(restartTimer(failedAgain).deadline - done.now, 200)
})

it("cancels delayed member and unit restarts on shutdown and ignores their late timers (C8)", () => {
	for (const failed of [
		signal(initial({ backoff }), "MemberFailed"),
		crash(initial({ backoff })),
	]) {
		const timer = restartTimer(failed.state)
		const closed = Core.reduce(failed.state, { _tag: "Shutdown", now: 10 })
		assert.equal(HashMap.size(closed.state.pendingRestarts), 0)
		assert.isFalse(
			Option.getOrThrow(HashMap.get(closed.state.timers, timer.id)).active,
		)
		assert.isTrue(
			Array.some(
				closed.commands,
				(c) => c.kind === "CancelTimer" && Option.contains(c.timer, timer.id),
			),
		)
		const late = fireRestart(closed.state, timer)
		assert.equal(restarts(late), 0)
		assert.equal(fact(late.state).attempts.length, 0)
		assert.equal(HashMap.size(late.state.preparations), 0)
	}
})

it("projects revocation and suppresses reasons while serving or owned by a Change (C7, C8)", () => {
	assert.isTrue(Option.isNone(downReason(initial())))
	assert.isTrue(Option.contains(downReason(revoke(initial())), "Revoked"))
	assert.isTrue(
		Option.contains(
			downReason(settle(signal(revoke(initial()), "MemberFailed").state)),
			"Revoked",
		),
	)
	const failed = signal(initial({ backoff }), "MemberFailed").state
	const owned = Core.reduce(failed, {
		_tag: "Submit",
		request: request(failed, "a", "Restart"),
		now: failed.now,
	})
	assert.equal(owned.reply._tag, "Admitted")
	assert.isTrue(Option.isNone(downReason(owned.state)))
})

it("projects a missing required dependency before a pending restart and ignores optional dependencies (C8)", () => {
	const pair = Core.make({
		authority: "dependency-status",
		maxUnits: 4,
		realms: rootRealms,
		declarations: Array.map(
			declaredMembers([
				{ id: "a", target: target("a") },
				{ id: "b", target: target("b") },
			]),
			(m) => ({
				...m,
				placement: Option.none(),
				...(m.instance === "a"
					? { localProvides: ["ab"] }
					: { localRequires: [{ key: "ab", optional: false }] }),
			}),
		),
		supervision: { backoff },
	})
	const failed = signal(pair, "MemberFailed").state
	assert.isTrue(
		Option.contains(downReason(failed, "b"), "WaitingForDependency"),
	)
	const optional = {
		...failed,
		graph: {
			...failed.graph,
			dependencies: HashMap.modify(failed.graph.dependencies, "b", (ds) =>
				Array.map(ds, (d) => ({ ...d, optional: true })),
			),
		},
	}
	assert.isTrue(Option.isNone(downReason(optional, "b")))
})

it("starts only the restart whose timer fired when independent instances are waiting (C8)", () => {
	const base = Core.make({
		authority: "independent-timers",
		maxUnits: 4,
		realms: rootRealms,
		declarations: declaredMembers([
			{ id: "a", target: target("a") },
			{ id: "b", target: target("b") },
		]),
		supervision: { backoff },
	})
	const a = signal(base, "MemberFailed").state
	const both = signal(at(a, 50), "MemberFailed", "b").state
	const pendingA = Option.getOrThrow(
		Array.findFirst(HashMap.values(both.pendingRestarts), (r) =>
			HashSet.has(r.members, "a"),
		),
	)
	const timerA = Option.getOrThrow(
		HashMap.get(both.timers, pendingA.timer ?? "Missing timer"),
	)
	const first = fireRestart(both, timerA)
	assert.deepEqual(
		Array.flatMap(first.commands, (c) =>
			c.kind === "StopMembers" ? Array.fromIterable(c.subjects) : [],
		),
		["a"],
	)
	assert.equal(HashMap.size(first.state.pendingRestarts), 1)
	const timerB = restartTimer(first.state)
	assert.equal(timerB.deadline, 150)
	const second = fireRestart(first.state, timerB)
	assert.deepEqual(
		Array.flatMap(second.commands, (c) =>
			c.kind === "StopMembers" ? Array.fromIterable(c.subjects) : [],
		),
		["b"],
	)
})

it("retains timer failure causes and escalates instead of silently releasing a delayed restart (C8)", () => {
	const failed = signal(initial({ backoff }), "MemberFailed").state
	const timer = restartTimer(failed)
	const ended = Core.reduce(failed, {
		_tag: "TimerEnded",
		timer: timer.id,
		generation: timer.generation,
		cause: Cause.fail("Restart timer failed"),
		now: 10,
	})
	assert.equal(restarts(ended), 0)
	assert.equal(HashMap.size(ended.state.pendingRestarts), 0)
	assert.equal(fact(ended.state).attempts.length, 0)
	assert.isTrue(Option.contains(downReason(ended.state), "Escalated"))
	assert.include(
		Cause.pretty(
			Option.getOrThrow(HashMap.get(ended.state.timers, timer.id)).cause,
		),
		"Restart timer failed",
	)
})
