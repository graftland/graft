import { Array, Cause, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore.ts"
import { deploymentIdentity } from "../src/internal/deploymentIdentity"
import * as Executions from "../src/internal/executionState"
import { declaredMembers, rootRealms } from "./member-fact"
import {
	command,
	described,
	description,
	exit,
	fire,
	id,
	initial,
	input,
	inspect,
	inspectionInput,
	prepare,
	report,
	resolved,
	spawned,
	target,
} from "./preparation-fixture.ts"

it("inspects an unregistered Loader module without creating an instance or a Change (F2)", () => {
	const request = { ...inspectionInput(), instance: "not-yet-admitted" }
	const first = inspect(initial(), request)
	assert.equal(first.reply._tag, "Preparing")
	assert.isFalse(HashMap.has(first.state.instances, request.instance))
	assert.equal(HashMap.size(first.state.changes), 0)
	assert.equal(HashMap.size(first.state.claims), 1)
})

it("refuses serving authority for a module-only inspection descriptor (I1, F2)", () => {
	const original = target()
	const deployment = original.deployment
	if (deployment === undefined)
		return assert.fail("Expected fixture deployment")
	const request: Core.Input = {
		...input(),
		operations: [
			{
				_tag: "Deploy",
				instance: "a",
				target: {
					...original,
					deployment: { ...deployment, inspection: "Module" },
				},
			},
		],
	}
	const denied = prepare(initial(), request)
	assert.equal(denied.reply._tag, "Rejected")
	assert.equal(HashMap.size(denied.state.claims), 0)
	assert.equal(HashMap.size(denied.state.changes), 0)
	assert.lengthOf(denied.commands, 0)
})

it("owns inspection capacity and observer identity before dispatch without locking an instance (I2, I4, I5)", () => {
	const first = prepare()
	const p = id(first)
	assert.equal(HashMap.size(first.state.changes), 0)
	assert.equal(HashMap.size(first.state.claims), 1)
	assert.isTrue(Option.isNone(Core.cell(first.state, "a").writer))
	const fact = Option.getOrThrow(Core.getPreparation(first.state, p))
	assert.equal(HashSet.size(fact.unconfirmedUnits), 1)
	assert.equal(HashMap.size(first.state.units), 1)
})
it("deduplicates pending inspection before capacity and rejects a different normalized keyed input (I2, I3)", () => {
	const first = prepare(initial(1), input("deployment"))
	const p = id(first)
	const repeated = prepare(first.state, input("deployment"))
	assert.deepEqual(repeated.reply, { _tag: "Preparing", preparation: p })
	assert.lengthOf(repeated.commands, 0)
	const conflict = prepare(first.state, {
		...input("deployment"),
		operations: [
			{ _tag: "Deploy", instance: "a", target: target("different") },
		],
	})
	assert.equal(conflict.reply._tag, "Rejected")
	if (conflict.reply._tag === "Rejected")
		assert.equal(conflict.reply.reason, "KeyConflict")
})
it("does not turn a Describe deadline or termination acknowledgement into noncreation (I2, I5)", () => {
	const first = prepare()
	const p = id(first)
	const running = spawned(first.state, p)
	const timed = fire(running, p, "Operation")
	const terminate = command(timed, p, "Terminate")
	const acknowledged = report(timed, terminate, { _tag: "Succeeded" })
	const rejected = fire(acknowledged, p, "Evidence")
	const fact = Option.getOrThrow(Core.getPreparation(rejected, p))
	assert.isTrue(Option.isSome(fact.result))
	assert.equal(HashMap.size(rejected.changes), 0)
	assert.equal(HashSet.size(fact.unconfirmedUnits), 1)
	assert.equal(HashMap.size(rejected.claims), 1)
})
it("retains a pre-admission rejection while late native exit releases only its original inspection (I2, I5, I10)", () => {
	const first = prepare()
	const p = id(first)
	const rejected = fire(
		fire(spawned(first.state, p), p, "Operation"),
		p,
		"Evidence",
	)
	const before = Option.getOrThrow(Core.getPreparation(rejected, p))
	const ended = exit(rejected, p).state
	const after = Option.getOrThrow(Core.getPreparation(ended, p))
	assert.strictEqual(after.result, before.result)
	assert.equal(HashSet.size(after.unconfirmedUnits), 0)
	assert.equal(HashMap.size(ended.claims), 0)
})
it("retains a complete Describe failure cause and rejects without a Change id after native exit (I1, I4, I6)", () => {
	const first = prepare()
	const p = id(first)
	const running = spawned(first.state, p)
	const cause = Cause.combine(
		Cause.fail("Decode failed"),
		Cause.die("Validation defect"),
	)
	const failed = report(running, command(running, p, "Describe"), {
		_tag: "Failed",
		cause,
		creation: "Unknown",
	})
	const ended = exit(failed, p).state
	const fact = Option.getOrThrow(Core.getPreparation(ended, p))
	assert.equal(HashMap.size(ended.changes), 0)
	assert.equal(fact.cause.reasons.length, 2)
	assert.equal(HashMap.size(ended.claims), 0)
})
it("requires inspection exit before admission and charges it to the original total deadline (I2, I11)", () => {
	const original = input()
	const first = prepare(initial(), {
		...original,
		budget: { ...original.budget, stop: 500 },
	})
	const p = id(first)
	const ready = described(first.state, p)
	assert.equal(HashMap.size(ready.changes), 0)
	const admitted = exit(ready, p, 300)
	assert.equal(admitted.reply._tag, "Admitted")
	if (admitted.reply._tag !== "Admitted") return
	const change = Option.getOrThrow(
		HashMap.get(admitted.state.changes, admitted.reply.change),
	)
	assert.equal(change.deadline, 3000)
	assert.equal(
		Option.getOrThrow(Core.get(admitted.state, change.id)).remaining,
		2700,
	)
})
it("rejects an expanded member footprint before candidate execution and retains inspection settlement (I3, I12)", () => {
	const first = prepare()
	const p = id(first)
	const bad = described(first.state, p, {
		...description(),
		members: declaredMembers([
			{ id: "a", target: target() },
			{ id: "undeclared", target: target() },
		]),
	})
	const rejected = exit(bad, p)
	assert.equal(rejected.reply._tag, "Rejected")
	assert.equal(HashMap.size(rejected.state.changes), 0)
	assert.equal(HashMap.size(rejected.state.claims), 0)
})
it("rejects uncached inspection at full capacity before stopping an old unit (I2, I5, I11)", () => {
	const base = Core.make({
		authority: "full",
		maxUnits: 1,
		declarations: Array.map(
			declaredMembers([{ id: "a", target: target("old") }]),
			(member) => ({ ...member, overlap: true }),
		),
		realms: rootRealms,
	})
	const denied = prepare(base)
	assert.equal(denied.reply._tag, "Rejected")
	if (denied.reply._tag === "Rejected")
		assert.equal(denied.reply.reason, "Capacity")
	assert.equal(HashMap.size(denied.state.changes), 0)
	assert.isFalse(
		Array.some(
			denied.commands,
			(c) => c.kind === "Stop" || c.kind === "Terminate",
		),
	)
	assert.isTrue(Executions.healthy(denied.state, "a"))
})
it("caches only matching immutable artifact, encoded configuration and validation environment (I4, I11)", () => {
	const first = inspect(initial(), inspectionInput())
	const p = id(first)
	const completed = exit(described(first.state, p), p).state
	const same = prepare(completed)
	assert.equal(same.reply._tag, "Admitted")
	const changed = prepare(completed, {
		...input(),
		operations: [
			{
				_tag: "Deploy",
				instance: "a",
				target: {
					...target(),
					deployment: {
						...Option.getOrThrow(Option.fromNullishOr(target().deployment)),
						input: { value: 2 },
					},
				},
			},
		],
	})
	assert.equal(changed.reply._tag, "Preparing")
})
it("rejects Runner Overlap before creating inspection or execution (I12)", () => {
	const denied = prepare(initial(), {
		...input(),
		strategy: "Overlap",
		operations: [
			{
				_tag: "Deploy",
				instance: "a",
				target: { ...target(), placement: "Runner" },
			},
		],
	})
	assert.equal(denied.reply._tag, "Rejected")
	assert.equal(HashMap.size(denied.state.units), 0)
	assert.lengthOf(denied.commands, 0)
})

it("rechecks current authorization after inspection and never locks an unauthorized submission (I3, I7)", () => {
	const first = prepare()
	const p = id(first)
	const ready = described(first.state, p)
	const revoked = Core.reduce(ready, {
		_tag: "PolicyChanged",
		instance: "a",
		allowed: [],
		values: {},
		now: ready.now,
	}).state
	const rejected = exit(revoked, p)
	assert.equal(rejected.reply._tag, "Rejected")
	assert.equal(HashMap.size(rejected.state.changes), 0)
	assert.isTrue(Option.isNone(Core.cell(rejected.state, "a").writer))
	assert.equal(HashMap.size(rejected.state.claims), 0)
})
it("validates execution declarations before Serve and retains its native exit obligation (I4, I5, I12)", () => {
	const first = prepare()
	const p = id(first)
	const admitted = exit(described(first.state, p), p)
	assert.equal(admitted.reply._tag, "Admitted")
	if (admitted.reply._tag !== "Admitted") return
	const change = admitted.reply.change
	const resolvedState = report(
		admitted.state,
		command(admitted.state, change, "Resolve"),
		{ _tag: "Resolved", value: resolved },
	)
	const running = report(
		resolvedState,
		command(resolvedState, change, "Spawn"),
		{ _tag: "Succeeded" },
	)
	const failed = report(running, command(running, change, "Start"), {
		endpoints: HashMap.empty(),
		_tag: "Started",
		value: {
			...description(),
			members: Array.map(description().members, (m) => ({
				...m,
				overlap: !m.overlap,
			})),
		},
	})
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(failed.commands)),
			(c) => c.change === change && c.kind === "Serve",
		),
	)
	const status = Option.getOrThrow(Core.get(failed, change))
	assert.isAbove(HashSet.size(status.unconfirmedUnits), 0)
	assert.isTrue(Option.isNone(status.conclusion))
})
it("consumes an execution term before uncertain native spawn and keeps that unit reserved at the deadline (I2, I5)", () => {
	const first = prepare()
	const p = id(first)
	const admitted = exit(described(first.state, p), p)
	if (admitted.reply._tag !== "Admitted")
		return assert.fail("Expected admission")
	const change = admitted.reply.change
	const resolving = report(
		admitted.state,
		command(admitted.state, change, "Resolve"),
		{ _tag: "Resolved", value: resolved },
	)
	const spawn = command(resolving, change, "Spawn")
	assert.equal(Option.getOrThrow(HashMap.get(spawn.token.members, "a")).term, 1)
	const failed = report(resolving, spawn, {
		_tag: "Failed",
		cause: Cause.fail("Creation uncertainty"),
		creation: "Unknown",
	})
	const stuck = fire(failed, change, "Evidence")
	const status = Option.getOrThrow(Core.get(stuck, change))
	assert.equal(Option.getOrThrow(status.conclusion).outcome, "Stuck")
	assert.equal(HashSet.size(status.unconfirmedUnits), 1)
	assert.equal(Option.getOrThrow(HashMap.get(stuck.instances, "a")).term, 1)
})

it("settles a dispatched inspection only from confirmed noncreation, never an unknown spawn failure (I2, I5)", () => {
	const first = prepare()
	const p = id(first)
	const resolving = report(first.state, command(first.state, p, "Resolve"), {
		_tag: "Resolved",
		value: resolved,
	})
	const failed = report(resolving, command(resolving, p, "Spawn"), {
		_tag: "Failed",
		creation: "NotStarted",
		cause: Cause.fail("Native creation rejected"),
	})
	const fact = Option.getOrThrow(Core.getPreparation(failed, p))
	assert.equal(fact.exitEvidence, "NotStarted")
	assert.equal(HashMap.size(failed.claims), 0)
	assert.isTrue(Option.isSome(fact.result))
})
it("bounds settled preparation history while retaining unresolved inspection evidence (I2, I10)", () => {
	const first = prepare({ ...initial(), historyLimit: 1 })
	const p = id(first)
	const missing = fire(
		fire(spawned(first.state, p), p, "Operation"),
		p,
		"Evidence",
	)
	const second = inspect(missing, inspectionInput())
	const q = id(second)
	const ended = exit(described(second.state, q), q).state
	const third = inspect(ended, inspectionInput())
	const r = id(third)
	const completed = exit(described(third.state, r), r).state
	assert.isTrue(Option.isNone(Core.getPreparation(completed, q)))
	assert.isTrue(Option.isSome(Core.getPreparation(completed, p)))
	assert.equal(HashMap.size(completed.preparations), 2)
})

it("uses the reserved recovery claim for a fresh Describe of a previously serving instance when current resolution changes (I2, I7, I11)", () => {
	const known = Core.make({
		authority: "preparation-test",
		maxUnits: 3,
		declarations: Array.map(
			declaredMembers([{ id: "a", target: target("old") }]),
			(member) => ({ ...member, overlap: true }),
		),
		realms: rootRealms,
		// The premise is an unavailable instance that no supervisor restarts.
		supervision: { intensity: 0 },
	})
	const old = HashMap.get(known.units, "a@0").pipe(Option.getOrThrow)
	const unavailable = Core.reduce(known, {
		_tag: "Exited",
		unit: old.id,
		incarnation: old.incarnation,
		observer: old.spawn,
		cleanup: { _tag: "Unknown" },
		cause: Cause.empty,
		now: 0,
	}).state
	const first = prepare(unavailable)
	const p = id(first)
	const admitted = exit(described(first.state, p), p)
	if (admitted.reply._tag !== "Admitted")
		return assert.fail("Expected admission")
	const change = admitted.reply.change
	const resolving = report(
		admitted.state,
		command(admitted.state, change, "Resolve"),
		{ _tag: "Resolved", value: resolved },
	)
	const spawnedState = report(resolving, command(resolving, change, "Spawn"), {
		_tag: "Failed",
		cause: Cause.fail("Rejected native creation"),
		creation: "NotStarted",
	})
	const recovery = command(spawnedState, change, "Resolve")
	const fresh = { ...resolved, input: { value: 2 }, identity: "config-2" }
	const inspecting = report(spawnedState, recovery, {
		_tag: "Resolved",
		value: fresh,
	})
	const inspections = Array.filter(
		Array.fromIterable(HashMap.values(inspecting.preparations)),
		(p) => Option.isNone(p.result),
	)
	assert.lengthOf(inspections, 1)
	assert.equal(HashMap.size(inspecting.claims), 1)
	assert.equal(HashMap.size(inspecting.changes), 1)
	assert.equal(
		Option.getOrThrow(HashMap.get(inspecting.changes, change)).deadline,
		3000,
	)
	const inspection = inspections[0]
	if (inspection === undefined)
		return assert.fail("Expected recovery inspection")
	const running = report(
		inspecting,
		command(inspecting, inspection.id, "Spawn"),
		{ _tag: "Succeeded" },
	)
	const describedState = report(
		running,
		command(running, inspection.id, "Describe"),
		{
			_tag: "Described",
			value: { ...description(target("old")), configuration: fresh.identity },
		},
	)
	const ended = exit(describedState, inspection.id).state
	const execution = command(ended, change, "Spawn")
	assert.equal(execution.target.identity, target("old").identity)
	assert.equal(execution.description?.configuration, "config-2")
	assert.equal(
		Option.getOrThrow(HashMap.get(execution.token.members, "a")).term,
		2,
	)
})

it("reserves inspection termination inside the absolute total budget (I5, I11)", () => {
	const first = prepare()
	const p = id(first)
	const total = Array.findFirst(
		HashMap.values(first.state.timers),
		(t) => t.change === p && t.purpose === "Total",
	).pipe(Option.getOrThrow)
	assert.equal(total.deadline, 2900)
})

it("snapshots unit declarations before retaining inspection evidence (I1, I4)", () => {
	const first = prepare()
	const p = id(first)
	const probes = ["health"]
	const d = {
		...description(),
		members: Array.map(description().members, (m) => ({ ...m, probes })),
	}
	const prepared = described(first.state, p, d)
	probes.push("late")
	const fact = HashMap.get(prepared.preparations, p).pipe(Option.getOrThrow)
	assert.deepEqual(Option.getOrThrow(fact.description).members[0]?.probes, [
		"health",
	])
})

it("finds a pending preparation key before closing or changed authorization (I2, I7)", () => {
	const first = prepare(initial(), input("pending"))
	const p = id(first)
	const changed = Core.reduce(first.state, {
		_tag: "PolicyChanged",
		instance: "a",
		allowed: [],
		values: {},
		now: 0,
	}).state
	const repeated = prepare({ ...changed, open: false }, input("pending"))
	assert.deepEqual(repeated.reply, { _tag: "Preparing", preparation: p })
	assert.equal(HashMap.size(repeated.state.preparations), 1)
})

it("retains admission conflict objects in a rejected preparation (I1, I3)", () => {
	const first = prepare()
	const p = id(first)
	const ready = described(first.state, p)
	const occupied = Core.reduce(ready, {
		_tag: "Submit",
		request: {
			instance: "a",
			proposal: {
				members: declaredMembers([{ id: "a", target: target("busy") }]),
				removed: HashSet.empty(),
				explicit: HashSet.make("a"),
				realms: [],
			},
			target: target("busy"),
			strategy: "Restart",
			reads: HashMap.make(["a", 0]),
			writes: HashSet.make("a"),
			leases: HashSet.empty(),
			participants: HashSet.empty(),
			budget: {
				total: 3000,
				startup: 500,
				probe: 100,
				drain: 100,
				stop: 100,
				terminate: 100,
			},
			trial: 0,
		},
		now: 0,
	}).state
	const rejected = exit(occupied, p)
	const result = Option.getOrThrow(
		Option.getOrThrow(Core.getPreparation(rejected.state, p)).result,
	)
	assert.equal(result._tag, "Rejected")
	if (result._tag === "Rejected")
		assert.sameMembers(Array.fromIterable(result.conflicts), [
			"a",
			"membership-of:a",
		])
})

it("keeps an inspection execution failure with its own preparation and preserves the complete native cause (I2, I3, I4)", () => {
	const first = prepare()
	const p = id(first)
	const running = spawned(first.state, p)
	const unit = HashMap.get(
		running.units,
		Option.getOrThrow(HashMap.get(running.preparations, p)).unit,
	).pipe(Option.getOrThrow)
	const original = Cause.combine(
		Cause.die("Native inspection defect"),
		Cause.fail("Native channel error"),
	)
	const failed = Core.reduce(running, {
		_tag: "UnitFailed",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		cause: original,
		now: 0,
	}).state
	const fact = Option.getOrThrow(Core.getPreparation(failed, p))
	assert.include(Cause.pretty(fact.cause), "Native inspection defect")
	assert.equal(fact.phase, "Terminating")
	assert.equal(Option.getOrThrow(fact.interrupted), "Describing")
	const ended = exit(failed, p).state
	assert.include(
		Cause.pretty(Option.getOrThrow(Core.getPreparation(ended, p)).cause),
		"Native channel error",
	)
})

it("rejects forged native code identity before resolving or spawning an inspection (I1, F2)", () => {
	const deployment = Option.getOrThrow(
		Option.fromNullishOr(target().deployment),
	)
	const forged = inspect(initial(), {
		...inspectionInput(),
		target: {
			...target(),
			deployment: { ...deployment, moduleSuffix: "?unapproved" },
		},
	})
	assert.equal(forged.reply._tag, "Rejected")
	assert.lengthOf(forged.commands, 0)
	assert.equal(HashMap.size(forged.state.preparations), 0)
})
it("snapshots native environment recipes and resolved module options before retaining them (I1, F2)", () => {
	const options = { value: "before" }
	const artifact = {
		directory: "/environment",
		identity: {
			version: 1,
			algorithm: "sha256",
			digest: "environment",
			entry: "index.js",
		},
	} satisfies Core.ArtifactData
	const recipe = { artifact, export: "default", options }
	const deployment = Option.getOrThrow(
		Option.fromNullishOr(target().deployment),
	)
	const desired = { ...deployment, environment: [recipe] }
	const request = {
		...inspectionInput(),
		target: {
			...target(),
			identity: deploymentIdentity(desired),
			deployment: desired,
		},
	}
	const first = inspect(initial(), request)
	options.value = "after"
	artifact.identity.digest = "changed"
	const p = Option.getOrThrow(HashMap.get(first.state.preparations, id(first)))
	assert.deepEqual(p.request.target.deployment?.environment?.[0]?.options, {
		value: "before",
	})
	assert.equal(
		p.request.target.deployment?.environment?.[0]?.artifact.identity.digest,
		"environment",
	)
	const resolvedState = report(
		first.state,
		command(first.state, id(first), "Resolve"),
		{ _tag: "Resolved", value: { ...resolved, environmentModules: [recipe] } },
	)
	options.value = "after report"
	artifact.identity.digest = "changed after report"
	const saved = Option.getOrThrow(
		HashMap.get(resolvedState.preparations, id(first)),
	)
	const resolution = Option.getOrThrow(saved.resolution)
	assert.deepEqual(resolution.environmentModules?.[0]?.options, {
		value: "after",
	})
	assert.equal(
		resolution.environmentModules?.[0]?.artifact.identity.digest,
		"changed",
	)
})

it("never reuses an identified description for another instance with the same artifact and configuration (I2, I4, F3)", () => {
	const before = Core.empty({
		authority: "description-coordinates",
		maxUnits: 4,
		instances: [
			{ id: "a", target: target() },
			{ id: "b", target: target() },
		],
	})
	const first = inspect(before, inspectionInput())
	const cached = exit(described(first.state, id(first)), id(first)).state
	const next = prepare(cached, {
		...input(),
		operations: [{ _tag: "Deploy", instance: "b", target: target() }],
	})
	assert.equal(next.reply._tag, "Preparing")
	assert.equal(HashMap.size(next.state.changes), 0)
})
