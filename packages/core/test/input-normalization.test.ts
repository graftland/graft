import { HashMap, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore.ts"
import { accept, initial } from "./change-model/scenarios.ts"
import { described, exit, id, target } from "./preparation-fixture.ts"

it("snapshots caller-owned probe arrays before retaining normalized identity (I1, I2)", () => {
	const probes = ["health"]
	const result = Core.reduce(initial(), {
		_tag: "Requested",
		now: 0,
		request: {
			operations: [
				{ _tag: "Deploy", instance: "instance-0", target: target("next") },
			],
			key: "deployment",
			requirements: { probes },
		},
	})
	probes[0] = "Changed after submission"
	assert.deepEqual(
		Option.getOrThrow(HashMap.get(result.state.preparations, "preparation-1"))
			.request.probes,
		["health"],
	)
})
it("finds normalized keyed identity before changed versions or closed admission (I2, I3)", () => {
	const input: Core.Input = {
		operations: [
			{ _tag: "Deploy", instance: "instance-0", target: target("next") },
		],
		strategy: "Overlap",
		key: "deployment",
	}
	const submitted = Core.reduce(initial(), {
		_tag: "Requested",
		now: 0,
		request: input,
	}).state
	const p = id({
		state: submitted,
		commands: [],
		reply: { _tag: "Preparing", preparation: "preparation-1" },
	})
	const admitted = exit(described(submitted, p), p).state
	const accepted = accept(admitted, "change-1")
	const closed = Core.reduce(accepted, {
		_tag: "Shutdown",
		now: accepted.now,
	}).state
	const repeated = Core.reduce(closed, {
		_tag: "Requested",
		now: closed.now,
		request: {
			...input,
			budget: { total: 300000 },
			requirements: { trial: 0, probes: [] },
		},
	})
	assert.deepEqual(repeated.reply, { _tag: "Admitted", change: "change-1" })
	const conflict = Core.reduce(closed, {
		_tag: "Requested",
		now: closed.now,
		request: {
			...input,
			operations: [
				{ _tag: "Deploy", instance: "instance-0", target: target("another") },
			],
		},
	})
	assert.equal(conflict.reply._tag, "Rejected")
	if (conflict.reply._tag === "Rejected")
		assert.equal(conflict.reply.reason, "KeyConflict")
})
it("rejects a stale expected version before producing public execution commands (I3)", () => {
	const result = Core.reduce(initial(), {
		_tag: "Requested",
		now: 0,
		request: {
			operations: [
				{
					_tag: "Deploy",
					instance: "instance-0",
					target: target("next"),
					expected: 0,
				},
			],
		},
	})
	assert.equal(result.reply._tag, "Rejected")
	if (result.reply._tag === "Rejected")
		assert.equal(result.reply.reason, "Stale")
	assert.lengthOf(result.commands, 0)
})
