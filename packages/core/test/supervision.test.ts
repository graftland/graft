import { Array, Cause, HashMap, Option, String } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import * as Executions from "../src/internal/executionState"
import { report } from "./change-model/scenarios"
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
): Core.Transition => {
	const current = Option.getOrThrow(Executions.current(state, "a"))
	const identity = {
		unit: current.unit.id,
		incarnation: current.unit.incarnation,
		observer: current.unit.spawn,
		member: "a",
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
