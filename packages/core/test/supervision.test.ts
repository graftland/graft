import { Array, Cause, HashMap, Option, String } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import * as Executions from "../src/internal/executionState"
import { report } from "./change-model/scenarios"
import { declaredMembers, rootRealms } from "./member-fact"
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
