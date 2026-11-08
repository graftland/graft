import { Array, Cause, HashMap, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore.ts"
import * as Executions from "../src/internal/executionState"
import {
	accept,
	fire,
	initial,
	report,
	submit,
} from "./change-model/scenarios.ts"
import { oneMember } from "./member-fact"

it("records idle serving failure without releasing its native capacity before exit (I2, I5, I6)", () => {
	const s = initial()
	const unit = Option.getOrThrow(HashMap.get(s.units, "instance-0@0"))
	const cause = Cause.combine(
		Cause.fail("Serving failed"),
		Cause.die("Background defect"),
	)
	const failed = Core.reduce(s, {
		_tag: "UnitFailed",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		cause,
		now: 0,
	})
	assert.isFalse(Executions.healthy(failed.state, "instance-0"))
	assert.equal(
		Option.getOrThrow(HashMap.get(failed.state.units, unit.id)).cause.reasons
			.length,
		2,
	)
	assert.equal(Core.capacity(failed.state).used, 2)
	assert.isTrue(
		Array.some(
			failed.commands,
			(c) => c.kind === "Terminate" && c.unit === unit.id,
		),
	)
	const ended = Core.reduce(failed.state, {
		_tag: "Exited",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		cause: Cause.empty,
		cleanup: { _tag: "Unknown" },
		now: 0,
	}).state
	assert.equal(Core.capacity(ended).used, 1)
})
it("keeps a transferred conclusion immutable when its serving generation later fails (I1, I10)", () => {
	const s = accept(submit(initial()), "change-1")
	const before = Option.getOrThrow(Core.get(s, "change-1"))
	const unit = Option.getOrThrow(HashMap.get(s.units, "instance-0@1"))
	const failed = Core.reduce(s, {
		_tag: "UnitFailed",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		cause: Cause.fail("Serving failed"),
		now: s.now,
	}).state
	const after = Option.getOrThrow(Core.get(failed, "change-1"))
	assert.strictEqual(after.conclusion, before.conclusion)
	assert.isFalse(oneMember(after).healthy)
})
it("does not let stale execution failure change a recreated incarnation (I2, I10)", () => {
	const s = accept(submit(initial()), "change-1")
	const unit = Option.getOrThrow(HashMap.get(s.units, "instance-0@1"))
	const ignored = Core.reduce(s, {
		_tag: "UnitFailed",
		unit: unit.id,
		incarnation: "another-incarnation",
		observer: unit.spawn,
		cause: Cause.die("Stale"),
		now: s.now,
	}).state
	assert.isTrue(Executions.healthy(ignored, "instance-0"))
})

it("settles retirement of an instance-owned serving unit from native exit before its blocked Stop can report (I2, I6, I7)", () => {
	const base = accept(submit(initial()), "change-1")
	const started = submit(base)
	const id = "change-2"
	const advance = (s: Core.State): Core.State => {
		const change = Option.getOrThrow(HashMap.get(s.changes, id))
		if (change.phase === "Retiring") return s
		if (change.phase === "Trial") return advance(fire(s, id, "Trial"))
		const kinds: ReadonlyArray<Core.CommandKind> = [
			"Resolve",
			"Spawn",
			"Start",
			"Serve",
			"Ready",
			"Probe",
			"Install",
		]
		const cmd = Option.getOrThrow(
			Option.fromNullishOr(
				Array.flatMap(kinds, (kind) =>
					Array.filter(
						Array.fromIterable(HashMap.values(s.commands)),
						(c) =>
							c.change === id && c.kind === kind && c.disposition === "Pending",
					),
				)[0],
			),
		)
		return advance(report(s, cmd))
	}
	const retiring = advance(started)
	const old = Option.getOrThrow(HashMap.get(retiring.units, "instance-0@1"))
	const disconnected = Core.reduce(retiring, {
		_tag: "UnitDisconnected",
		unit: old.id,
		incarnation: old.incarnation,
		observer: old.spawn,
		cause: Cause.fail("Control closed"),
		now: retiring.now,
	}).state
	const ended = Core.reduce(disconnected, {
		_tag: "Exited",
		unit: old.id,
		incarnation: old.incarnation,
		observer: old.spawn,
		cause: Cause.empty,
		cleanup: { _tag: "Unknown" },
		now: retiring.now,
	}).state
	assert.equal(
		Option.getOrThrow(Option.getOrThrow(Core.get(ended, id)).conclusion)
			.outcome,
		"Accepted",
	)
})
