import { Array, Cause, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import { capacity } from "./change-model/assertions"
import {
	conclusion,
	exit,
	fire,
	initial,
	installed,
	pending,
	report,
	request,
	status,
	submit,
	succeed,
} from "./change-model/scenarios"

const kinds: ReadonlyArray<Core.CommandKind> = [
	"Resolve",
	"Spawn",
	"Start",
	"Serve",
	"Ready",
	"Probe",
	"Install",
]
const advance = (state: Core.State, until: Core.CommandKind) =>
	Array.reduce(
		Array.takeWhile(kinds, (kind) => kind !== until),
		state,
		(s, kind) => succeed(s, "change-1", kind),
	)
const candidate = (state: Core.State) =>
	Option.getOrThrow(
		Option.getOrThrow(HashMap.get(state.changes, "change-1")).candidate,
	)
const assertSettled = (state: Core.State, outcome: Core.Outcome) => {
	assert.equal(
		conclusion(state).outcome,
		outcome,
		Cause.pretty(conclusion(state).cause),
	)
	assert.equal(HashSet.size(status(state).leaseHolders), 0)
	assert.equal(HashSet.size(status(state).unconfirmedUnits), 0)
	capacity(state)
}
for (const kind of [
	"Start",
	"Serve",
	"Ready",
	"Probe",
] satisfies ReadonlyArray<Core.CommandKind>) {
	it(`settles a stalled forward ${kind} before old change as Aborted only after candidate exit (I2, I5, I6, I7, I11)`, () => {
		const waiting = advance(submit(initial()), kind)
		const ended = exit(
			fire(waiting, "change-1", "Operation"),
			candidate(waiting),
		)
		assertSettled(ended, "Aborted")
		assert.equal(status(ended).member.healthy, true)
		assert.equal(
			Option.getOrThrow(status(ended).member.actual).identity,
			"original",
		)
	})
	it(`restores service after stalled forward ${kind} following old stop with full recovery trial (I2, I5, I6, I7, I11)`, () => {
		const base = initial()
		const admitted = submit(base, request(base, "instance-0", "Restart"))
		const waiting = advance(exit(admitted, "instance-0@0"), kind)
		const recovery = exit(
			fire(waiting, "change-1", "Operation"),
			candidate(waiting),
		)
		const trial = installed(recovery, "change-1")
		assert.isTrue(Option.isNone(status(trial).conclusion))
		const ended = fire(trial, "change-1", "Trial")
		assertSettled(ended, "Recovered")
		assert.equal(
			Option.getOrThrow(status(ended).member.actual).identity,
			"original",
		)
	})
	it(`settles stalled recovery ${kind} as RecoveryFailed only after its own exit (I2, I5, I6, I7, I11)`, () => {
		const base = initial()
		const admitted = submit(base, request(base, "instance-0", "Restart"))
		const starting = advance(exit(admitted, "instance-0@0"), "Start")
		const failed = report(starting, pending(starting, "change-1", "Start"), {
			_tag: "Failed",
			cause: Cause.die("Forward startup failed"),
			creation: "Unknown",
		})
		const recovery = exit(failed, candidate(starting))
		const waiting = advance(recovery, kind)
		const expired = fire(waiting, "change-1", "Operation")
		assert.isTrue(Option.isNone(status(expired).conclusion))
		const ended = exit(expired, candidate(waiting))
		assertSettled(ended, "RecoveryFailed")
		assert.isFalse(status(ended).member.healthy)
		assert.include(
			Cause.pretty(conclusion(ended).cause),
			"Forward startup failed",
		)
	})
}
it("settles an expired recovery trial as RecoveryFailed with no serving target after exit (I2, I5, I7, I11)", () => {
	const base = initial()
	const admitted = submit(base, request(base, "instance-0", "Restart"))
	const starting = advance(exit(admitted, "instance-0@0"), "Start")
	const failed = report(starting, pending(starting, "change-1", "Start"), {
		_tag: "Failed",
		cause: Cause.die("Forward failed"),
		creation: "Unknown",
	})
	const recovery = exit(failed, candidate(starting))
	const trial = installed(recovery, "change-1")
	const total = fire(trial, "change-1", "Total")
	const ended = exit(total, candidate(trial))
	assertSettled(ended, "RecoveryFailed")
	assert.isFalse(status(ended).member.healthy)
})

it("rejects invalid and insufficient two-trial budgets before inspection or Change admission (I1, I2, I11)", () => {
	const base = initial()
	const normal = request(base)
	for (const input of [
		{ ...normal, budget: { ...normal.budget, total: 0 } },
		{ ...normal, budget: { ...normal.budget, startup: -1 } },
		{
			...normal,
			budget: { ...normal.budget, total: Number.POSITIVE_INFINITY },
		},
		{ ...normal, trial: Number.NaN },
		{ ...normal, trial: 251 },
	]) {
		const denied = Core.reduce(base, {
			_tag: "Submit",
			request: input,
			now: base.now,
		})
		assert.equal(denied.reply._tag, "Rejected")
		if (denied.reply._tag === "Rejected")
			assert.equal(denied.reply.reason, "InvalidBudget")
		assert.equal(HashMap.size(denied.state.changes), 0)
		assert.equal(HashMap.size(denied.state.preparations), 0)
		assert.equal(HashMap.size(denied.state.claims), HashMap.size(base.claims))
		assert.deepEqual(
			Core.cell(denied.state, "instance-0"),
			Core.cell(base, "instance-0"),
		)
		assert.equal(
			Option.getOrThrow(HashMap.get(denied.state.instances, "instance-0"))
				.healthy,
			true,
		)
		assert.lengthOf(denied.commands, 0)
	}
})
