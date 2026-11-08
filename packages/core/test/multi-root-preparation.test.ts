import { Cause, HashMap, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import {
	described,
	exit,
	id,
	initial,
	input,
	prepare,
	target,
} from "./preparation-fixture"

it("keeps a later root's inspection ownership after a previous root's expected disconnect and duplicate exit (I5, I7, F2, F12)", () => {
	const first = prepare(initial(4), {
		...input(),
		operations: [
			{ _tag: "Deploy", instance: "a", target: target() },
			{ _tag: "Deploy", instance: "b", target: target("b") },
		],
	})
	const preparation = id(first)
	const old = Option.getOrThrow(
		HashMap.get(
			first.state.units,
			Option.getOrThrow(HashMap.get(first.state.preparations, preparation))
				.unit,
		),
	)
	const next = exit(described(first.state, preparation), preparation).state
	const active = Option.getOrThrow(HashMap.get(next.preparations, preparation))
	assert.notEqual(active.unit, old.id)
	const disconnected = Core.reduce(next, {
		_tag: "UnitDisconnected",
		unit: old.id,
		incarnation: old.incarnation,
		observer: old.spawn,
		cause: Cause.fail("Expected inspection disconnect"),
		now: next.now,
	}).state
	const observed = Option.getOrThrow(
		HashMap.get(disconnected.preparations, preparation),
	)
	assert.equal(observed.unit, active.unit)
	assert.equal(observed.phase, "Resolving")
	assert.isTrue(Option.isNone(observed.failure))
	assert.isTrue(
		Option.contains(
			Option.getOrThrow(HashMap.get(disconnected.claims, observed.claim)).unit,
			observed.unit,
		),
	)
	const duplicate = Core.reduce(disconnected, {
		_tag: "Exited",
		unit: old.id,
		incarnation: old.incarnation,
		observer: old.spawn,
		cleanup: { _tag: "Completed" },
		cause: Cause.empty,
		now: disconnected.now,
	}).state
	assert.equal(
		Option.getOrThrow(HashMap.get(duplicate.preparations, preparation)).unit,
		active.unit,
	)
})
