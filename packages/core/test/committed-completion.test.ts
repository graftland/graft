import { Array, HashMap, Option, type Schema } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import * as Executions from "../src/internal/executionState"
import { declaredMembers, rootRealms } from "./member-fact"
import {
	described,
	description,
	exit,
	id,
	input,
	prepare,
	target,
} from "./preparation-fixture"

const running = () =>
	Core.make({
		authority: "committed",
		maxUnits: 6,
		declarations: Array.map(
			declaredMembers([{ id: "a", target: target("old") }]),
			(member) => ({ ...member, placement: Option.none() }),
		),
		realms: rootRealms,
	})
const committed = (state = running()) => {
	const first = prepare(state, { ...input(), completion: "Committed" })
	const p = id(first)
	return exit(described(first.state, p, description(target(), "a")), p)
}

it("concludes a Committed Change once the desired state is recorded, before anything runs (K1)", () => {
	const admitted = committed()
	assert.equal(admitted.reply._tag, "Admitted")
	const change = admitted.reply._tag === "Admitted" ? admitted.reply.change : ""
	const status = Option.getOrThrow(Core.get(admitted.state, change))
	assert.equal(status.completion, "Committed")
	assert.equal(Option.getOrThrow(status.conclusion).outcome, "Accepted")
	// The old target still serves; the committed one is the desired declaration.
	assert.equal(
		Option.getOrThrow(Executions.current(admitted.state, "a")).member.target
			.identity,
		target("old").identity,
	)
	assert.equal(
		Option.getOrThrow(HashMap.get(admitted.state.graph.declarations, "a"))
			.target.identity,
		target().identity,
	)
	// Reconciliation is its own Change, linked to the committed one.
	const reconciling = Array.filter(
		[
			...Array.map(
				Array.fromIterable(HashMap.keys(admitted.state.changes)),
				(id) => Option.getOrThrow(Core.get(admitted.state, id)).origin,
			),
			...Array.map(
				Array.fromIterable(HashMap.values(admitted.state.preparations)),
				(p) => Option.fromUndefinedOr(p.request.origin),
			),
		],
		(origin) => Option.contains(origin, change),
	)
	assert.lengthOf(reconciling, 1)
	// The committed Change itself stops and starts nothing.
	assert.isFalse(
		Array.some(
			admitted.commands,
			(c) => c.change === change && (c.kind === "Stop" || c.kind === "Spawn"),
		),
	)
})

it("never accepts an unauthorized target as Committed (K1)", () => {
	const revoked = Core.reduce(running(), {
		_tag: "PolicyChanged",
		instance: "a",
		allowed: [target("old").identity],
		values: {},
		now: 0,
	}).state
	const refused = prepare(revoked, { ...input(), completion: "Committed" })
	assert.equal(refused.reply._tag, "Rejected")
	assert.equal(HashMap.size(refused.state.changes), 0)
})

it("refuses a Committed removal, which cannot be reconciled yet (K1)", () => {
	const refused = prepare(running(), {
		operations: [{ _tag: "Remove", instance: "a" }],
		completion: "Committed",
	})
	assert.equal(refused.reply._tag, "Rejected")
})

const reconciling = (state: Core.State, origin: string) =>
	Array.filter(
		Array.fromIterable(HashMap.values(state.changes)),
		(c) => c.request.origin === origin,
	)
const withInput = (t: Core.Target, input: Schema.Json): Core.Target => ({
	...t,
	deployment: { ...t.deployment!, input },
})

it("reconciles a Committed configuration change with the same code (K1)", () => {
	const old = withInput(target("same"), { value: 1 })
	const next = withInput(target("same"), { value: 2 })
	assert.equal(old.identity, next.identity)
	const state = Core.make({
		authority: "committed",
		maxUnits: 6,
		declarations: Array.map(
			declaredMembers([{ id: "a", target: old }]),
			(member) => ({ ...member, placement: Option.none() }),
		),
		realms: rootRealms,
	})
	const first = prepare(state, {
		operations: [{ _tag: "Deploy", instance: "a", target: next }],
		completion: "Committed",
	})
	const p = id(first)
	const admitted = exit(described(first.state, p, description(next, "a")), p)
	assert.equal(admitted.reply._tag, "Admitted")
	const change = admitted.reply._tag === "Admitted" ? admitted.reply.change : ""
	assert.lengthOf(reconciling(admitted.state, change), 1)
})

it("keeps the committed probes and trial for reconciliation (K1)", () => {
	const first = prepare(running(), {
		...input(),
		completion: "Committed",
		requirements: { probes: ["deep"], trial: 500 },
	})
	const p = id(first)
	const admitted = exit(
		described(first.state, p, description(target(), "a")),
		p,
	)
	const change = admitted.reply._tag === "Admitted" ? admitted.reply.change : ""
	const linked = reconciling(admitted.state, change)
	assert.lengthOf(linked, 1)
	assert.deepStrictEqual(linked[0]!.request.probes, ["deep"])
	assert.equal(linked[0]!.request.trial, 500)
})
