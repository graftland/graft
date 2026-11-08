import { Array as Arr, Cause, Equal, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore.ts"
import { capacity } from "./change-model/assertions.ts"
import {
	accept,
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
} from "./change-model/scenarios.ts"
import { declaredMembers, oneMember, rootRealms } from "./member-fact"

it("does not activate a partially installed view or accept another view token (I8)", () => {
	const base = initial()
	const s = installed(
		submit(base, {
			...request(base),
			participants: HashSet.make("instance-1@0"),
		}),
		"change-1",
	)
	assert.strictEqual(status(s).phase, "Installing")
	assert.strictEqual(Core.cell(s, "instance-0").version, 1)
	const command = pending(s, "change-1", "Install")
	const stale = Core.reduce(s, {
		_tag: "Reported",
		command: command.id,
		token: { ...command.token, view: 0 },
		result: { _tag: "Succeeded" },
		now: s.now,
	}).state
	assert.isTrue(Equal.equals(stale, s))
	const active = succeed(s, "change-1", "Install")
	assert.strictEqual(Core.cell(active, "instance-0").version, 2)
	assert.strictEqual(status(active).phase, "Trial")
})

it("retains shared read premises and fences their writer without merging partial plans (I3)", () => {
	const base = initial(3, 5)
	const shared = "realm/service"
	const a = {
		...request(base),
		reads: HashMap.set(request(base).reads, shared, 0),
	}
	const b = {
		...request(base, "instance-1"),
		reads: HashMap.set(request(base, "instance-1").reads, shared, 0),
	}
	const admitted = submit(submit(base, a), b)
	const writer = {
		...request(base, "instance-2"),
		reads: HashMap.set(request(base, "instance-2").reads, shared, 0),
		writes: HashSet.make("instance-2", shared),
	}
	const rejected = Core.reduce(admitted, {
		_tag: "Submit",
		request: writer,
		now: 0,
	})
	assert.strictEqual(rejected.reply._tag, "Rejected")
	assert.strictEqual(HashSet.size(Core.cell(admitted, shared).readers), 2)
	assert.strictEqual(HashMap.size(rejected.state.changes), 2)
})

it("accepts forced Overlap retirement with unknown cleanup only after native exit (I5, I6)", () => {
	const trial = fire(
		installed(submit(initial()), "change-1"),
		"change-1",
		"Trial",
	)
	const stop = pending(trial, "change-1", "Stop")
	const forced = fire(trial, "change-1", "Operation")
	assert.isTrue(Option.isNone(status(forced).conclusion))
	const ended = exit(forced, stop.unit)
	assert.strictEqual(conclusion(ended).outcome, "Accepted")
	assert.strictEqual(status(ended).settlement, "UnknownCleanup")
	assert.strictEqual(
		Option.getOrThrow(HashMap.get(ended.units, stop.unit)).cleanup._tag,
		"Unknown",
	)
	assert.isAbove(conclusion(ended).cause.reasons.length, 0)
})

it("treats known retirement cleanup failure as failed success evidence and recovers (I6, I7)", () => {
	const trial = fire(
		installed(submit(initial()), "change-1"),
		"change-1",
		"Trial",
	)
	const old = pending(trial, "change-1", "Stop").unit
	const failed = exit(trial, old, {
		_tag: "Failed",
		cause: Cause.die("Finalizer failed"),
	})
	const candidate = Option.getOrThrow(
		HashMap.get(failed.changes, "change-1"),
	).candidate
	const settled = exit(failed, Option.getOrThrow(candidate))
	const recovered = fire(installed(settled, "change-1"), "change-1", "Trial")
	assert.strictEqual(conclusion(recovered).outcome, "Recovered")
	assert.strictEqual(status(recovered).settlement, "Failed")
	assert.isAbove(conclusion(recovered).cause.reasons.length, 0)
})

it("does not extend the evidence deadline when a termination command fails (I5, I11)", () => {
	const spawning = succeed(submit(initial()), "change-1", "Resolve")
	const expired = fire(spawning, "change-1", "Operation")
	const timer = Option.getOrThrow(
		Arr.findFirst(
			HashMap.values(expired.timers),
			(t) => t.active && t.purpose === "Evidence",
		),
	)
	const command = pending(expired, "change-1", "Terminate")
	const failed = Core.reduce(expired, {
		_tag: "Reported",
		command: command.id,
		token: command.token,
		result: {
			_tag: "Failed",
			cause: Cause.fail("Kill failed"),
			creation: "Unknown",
		},
		now: expired.now + 20,
	}).state
	const current = Option.getOrThrow(
		Arr.findFirst(
			HashMap.values(failed.timers),
			(t) => t.active && t.purpose === "Evidence",
		),
	)
	assert.strictEqual(current.deadline, timer.deadline)
	assert.strictEqual(
		conclusion(fire(failed, "change-1", "Evidence")).outcome,
		"Stuck",
	)
})

it("does not lose an original late command cause after immutable Stuck (I5, I10)", () => {
	const s = succeed(submit(initial()), "change-1", "Resolve")
	const command = pending(s, "change-1", "Spawn")
	const stuck = fire(fire(s, "change-1", "Operation"), "change-1", "Evidence")
	const old = conclusion(stuck)
	const late = report(stuck, command, {
		_tag: "Failed",
		creation: "NotStarted",
		cause: Cause.die({ detail: "Late creation failure" }),
	})
	assert.strictEqual(conclusion(late), old)
	assert.isAbove(
		status(late).cause.reasons.length,
		status(stuck).cause.reasons.length,
	)
	assert.strictEqual(Core.capacity(late).reserved, 0)
	capacity(late)
})

it("retains the absolute deadline and consumes a fresh term across Overlap failure and Restart-only recovery (I7, I11)", () => {
	const base = Core.make({
		authority: "test",
		maxUnits: 3,
		declarations: declaredMembers([
			{
				id: "instance-0",
				target: { identity: "original", placement: "Process", overlap: true },
			},
		]),
		realms: rootRealms,
	})
	const s = installed(submit(base), "change-1")
	const deadline = Option.getOrThrow(
		HashMap.get(s.changes, "change-1"),
	).deadline
	const cancelled = Core.reduce(s, {
		_tag: "Cancel",
		change: "change-1",
		cause: Cause.fail("Trial failed"),
		now: s.now + 5,
	}).state
	const ended = exit(exit(cancelled, "instance-0@0"), "instance-0@1")
	const recovery = installed(ended, "change-1")
	assert.strictEqual(
		pending(recovery, "change-1", "Activate").target.placement,
		"Process",
	)
	assert.strictEqual(
		Option.getOrThrow(HashMap.get(recovery.changes, "change-1")).deadline,
		deadline,
	)
	assert.strictEqual(
		conclusion(fire(recovery, "change-1", "Trial")).outcome,
		"Recovered",
	)
})

it("bounds settled unkeyed history without retaining predecessor command graphs (I10)", () => {
	const base = { ...initial(1, 2), historyLimit: 2 }
	const done = Arr.reduce(
		Arr.makeBy(5, (i) => `change-${i + 1}`),
		base,
		(s, id) => accept(submit(s), id),
	)
	assert.isTrue(Option.isNone(Core.get(done, "change-1")))
	assert.strictEqual(HashMap.size(done.changes), 2)
	assert.isFalse(
		Arr.some(
			Arr.fromIterable(HashMap.values(done.commands)),
			(c) => c.change === "change-1",
		),
	)
	assert.strictEqual(
		Option.getOrThrow(HashMap.get(done.instances, "instance-0")).term,
		5,
	)
	capacity(done)
})

it("returns a keyed record before stale or closing checks and never executes it again (I2, I3)", () => {
	const base = initial()
	const r = { ...request(base), key: "deployment" }
	const done = accept(submit(base, r), "change-1")
	const closed = Core.reduce(done, { _tag: "Shutdown", now: done.now }).state
	const duplicate = Core.reduce(closed, {
		_tag: "Submit",
		request: r,
		now: closed.now,
	})
	assert.deepStrictEqual(duplicate.reply, {
		_tag: "Admitted",
		change: "change-1",
	})
	const conflict = Core.reduce(closed, {
		_tag: "Submit",
		request: { ...r, trial: 11 },
		now: closed.now,
	})
	assert.strictEqual(conflict.reply._tag, "Rejected")
	assert.strictEqual(HashMap.size(duplicate.state.changes), 1)
})

it("makes explicit cancellation and runtime shutdown idempotent (I2, I10)", () => {
	const s = succeed(submit(initial()), "change-1", "Resolve")
	const event: Core.Event = {
		_tag: "Cancel",
		change: "change-1",
		cause: Cause.fail("Cancelled"),
		now: s.now,
	}
	const once = Core.reduce(s, event).state
	assert.isTrue(Equal.equals(once, Core.reduce(once, event).state))
	const closing = Core.reduce(once, { _tag: "Shutdown", now: once.now }).state
	assert.isTrue(
		Equal.equals(
			closing,
			Core.reduce(closing, { _tag: "Shutdown", now: closing.now }).state,
		),
	)
})

it("refreshes read-only premises for recovery while retaining write ownership (I3, I7)", () => {
	const base = initial()
	const binding = "dependency/authorization"
	const r = {
		...request(base),
		reads: HashMap.set(request(base).reads, binding, 0),
	}
	const s = installed(submit(base, r), "change-1")
	const invalid = Core.reduce(s, {
		_tag: "Invalidated",
		object: binding,
		cause: Cause.fail("Binding invalidated"),
		now: s.now,
	}).state
	const settled = exit(exit(invalid, "instance-0@0"), "instance-0@1")
	const recovered = fire(installed(settled, "change-1"), "change-1", "Trial")
	assert.strictEqual(conclusion(recovered).outcome, "Recovered")
	assert.strictEqual(
		Option.getOrThrow(HashMap.get(recovered.changes, "change-1")).premises.pipe(
			HashMap.get(binding),
			Option.getOrThrow,
		),
		1,
	)
})

it("attaches late lifecycle reports to their original attempt without advancing or failing recovery (I2, I8)", () => {
	const base = initial()
	const admitted = submit(base, request(base, "instance-0", "Restart"))
	const oldExited = exit(admitted, pending(admitted, "change-1", "Stop").unit)
	const starting = succeed(
		succeed(oldExited, "change-1", "Resolve"),
		"change-1",
		"Spawn",
	)
	const stale = pending(starting, "change-1", "Start")
	const failed = Core.reduce(starting, {
		_tag: "Cancel",
		change: "change-1",
		cause: Cause.fail("Cancel forward attempt"),
		now: starting.now,
	}).state
	const recovery = exit(failed, stale.unit)
	const newStarting = succeed(
		succeed(recovery, "change-1", "Resolve"),
		"change-1",
		"Spawn",
	)
	const late = report(newStarting, stale)
	assert.strictEqual(status(late).phase, "Starting")
	assert.isFalse(
		Arr.some(
			Arr.fromIterable(HashMap.values(late.commands)),
			(c) => c.kind === "Serve" && c.unit === stale.unit,
		),
	)
	const defect = report(newStarting, stale, {
		_tag: "Failed",
		cause: Cause.die("Late old failure"),
		creation: "Unknown",
	})
	assert.strictEqual(status(defect).phase, "Starting")
	assert.isAbove(
		status(defect).cause.reasons.length,
		status(newStarting).cause.reasons.length,
	)
})

it("transfers a serving target once at Stuck conclusion independently of late retirement (I2, I10)", () => {
	const base = initial()
	const r = { ...request(base), leases: HashSet.make("instance-1@0") }
	const retiring = fire(
		installed(submit(base, r), "change-1"),
		"change-1",
		"Trial",
	)
	const stuck = fire(
		fire(retiring, "change-1", "Operation"),
		"change-1",
		"Evidence",
	)
	assert.strictEqual(conclusion(stuck).outcome, "Stuck")
	const serving = Option.getOrThrow(Core.cell(stuck, "instance-0").value)
	assert.strictEqual(
		Option.getOrThrow(HashMap.get(stuck.units, serving)).owner,
		"instance:instance-0",
	)
	assert.strictEqual(HashSet.size(status(stuck).leaseHolders), 0)
	const dead = exit(stuck, serving)
	const settled = exit(dead, "instance-0@0")
	assert.strictEqual(conclusion(settled), conclusion(stuck))
	assert.isTrue(Option.isNone(Core.cell(settled, "instance-0").writer))
	assert.strictEqual(Core.capacity(settled).used, 1)
	capacity(settled)
})

it("expires an overdue operation before accepting its delayed command report (I5, I11)", () => {
	const spawning = succeed(submit(initial()), "change-1", "Resolve")
	const c = pending(spawning, "change-1", "Spawn")
	const late = Core.reduce(spawning, {
		_tag: "Reported",
		command: c.id,
		token: c.token,
		result: { _tag: "Succeeded" },
		now: 60,
	}).state
	assert.strictEqual(status(late).phase, "Settling")
	assert.isFalse(
		Arr.some(
			Arr.fromIterable(HashMap.values(late.commands)),
			(c) => c.kind === "Start",
		),
	)
	assert.strictEqual(pending(late, "change-1", "Terminate").unit, c.unit)
})

it("preserves Stuck when exit first arrives after the evidence deadline (I5, I10, I11)", () => {
	const spawning = succeed(submit(initial()), "change-1", "Resolve")
	const c = pending(spawning, "change-1", "Spawn")
	const terminating = fire(spawning, "change-1", "Operation")
	const u = Option.getOrThrow(HashMap.get(terminating.units, c.unit))
	const late = Core.reduce(terminating, {
		_tag: "Exited",
		unit: u.id,
		incarnation: u.incarnation,
		observer: u.spawn,
		cleanup: { _tag: "Unknown" },
		cause: Cause.empty,
		now: 101,
	}).state
	assert.strictEqual(conclusion(late).outcome, "Stuck")
	assert.strictEqual(HashSet.size(status(late).unconfirmedUnits), 0)
	assert.isTrue(Option.isNone(Core.cell(late, "instance-0").writer))
})

it("cannot accept a trial report delivered after the absolute submission budget (I11)", () => {
	const trial = installed(submit(initial()), "change-1")
	const t = Option.getOrThrow(
		Arr.findFirst(
			HashMap.values(trial.timers),
			(t) => t.active && t.purpose === "Trial",
		),
	)
	const late = Core.reduce(trial, {
		_tag: "TimerFired",
		timer: t.id,
		generation: t.generation,
		now: 1001,
	}).state
	assert.strictEqual(conclusion(late).outcome, "Stuck")
	assert.isTrue(
		Option.getOrThrow(HashMap.get(late.changes, "change-1")).failure,
	)
})

it("terminates settled and idle serving units on shutdown without inventing Change records (I2, I5, I7)", () => {
	const accepted = accept(submit(initial()), "change-1")
	const closing = Core.reduce(accepted, { _tag: "Shutdown", now: accepted.now })
	assert.strictEqual(HashMap.size(closing.state.changes), 1)
	assert.strictEqual(conclusion(closing.state), conclusion(accepted))
	for (const unit of HashMap.values(closing.state.units)) {
		if (unit.evidence === "Missing") {
			assert.strictEqual(unit.phase, "Terminating")
			assert.isTrue(
				Arr.some(
					closing.commands,
					(c) => c.kind === "Terminate" && c.unit === unit.id,
				),
			)
		}
	}
	assert.isFalse(oneMember(status(closing.state)).healthy)
	assert.strictEqual(Core.capacity(closing.state).used, 2)
})

it("keeps instance and Change ownership identities disjoint for arbitrary instance names (I2)", () => {
	const base = Core.make({
		authority: "test",
		maxUnits: 2,
		declarations: declaredMembers([
			{
				id: "change-1",
				target: { identity: "original", placement: "Worker", overlap: true },
			},
		]),
		realms: rootRealms,
	})
	const accepted = accept(submit(base, request(base, "change-1")), "change-1")
	const serving = Option.getOrThrow(Core.cell(accepted, "change-1").value)
	const u = Option.getOrThrow(HashMap.get(accepted.units, serving))
	assert.notStrictEqual(u.owner, "change-1")
	assert.strictEqual(conclusion(exit(accepted, serving)), conclusion(accepted))
	capacity(accepted)
})

it("retains old exit obligations when shutdown follows cancellation during settlement (I2, I5, I7)", () => {
	const spawning = succeed(submit(initial()), "change-1", "Resolve")
	const unit = pending(spawning, "change-1", "Spawn").unit
	const cancelled = Core.reduce(spawning, {
		_tag: "Cancel",
		change: "change-1",
		cause: Cause.fail("Cancelled"),
		now: spawning.now,
	}).state
	const closing = Core.reduce(cancelled, {
		_tag: "Shutdown",
		now: cancelled.now,
	}).state
	const candidateExited = exit(closing, unit)
	assert.isTrue(Option.isNone(status(candidateExited).conclusion))
	assert.isTrue(
		HashSet.has(status(candidateExited).unconfirmedUnits, "instance-0@0"),
	)
	assert.isTrue(
		Option.contains(
			Core.cell(candidateExited, "instance-0").writer,
			"change-1",
		),
	)
	assert.strictEqual(
		conclusion(fire(candidateExited, "change-1", "Evidence")).outcome,
		"Stuck",
	)
})

it("settles newly invalidated old execution before starting exclusive recovery (I2, I7)", () => {
	const base = initial()
	const r = {
		...request(base),
		reads: HashMap.set(request(base).reads, "authorization", 0),
	}
	const spawning = succeed(submit(base, r), "change-1", "Resolve")
	const candidate = pending(spawning, "change-1", "Spawn").unit
	const cancelled = Core.reduce(spawning, {
		_tag: "Cancel",
		change: "change-1",
		cause: Cause.fail("Cancelled"),
		now: spawning.now,
	}).state
	const invalid = Core.reduce(cancelled, {
		_tag: "Invalidated",
		object: "authorization",
		cause: Cause.fail("Old authorization invalidated"),
		now: cancelled.now,
	}).state
	const ended = exit(invalid, candidate)
	assert.isTrue(status(ended).oldChanged)
	assert.isFalse(oneMember(status(ended)).healthy)
	assert.isFalse(
		Arr.some(
			Arr.fromIterable(HashMap.values(ended.commands)),
			(c) => c.kind === "Resolve" && c.disposition === "Pending",
		),
	)
	const readyToRecover = exit(ended, "instance-0@0")
	assert.strictEqual(status(readyToRecover).phase, "Resolving")
	assert.isTrue(status(readyToRecover).recovering)
})

it("evicts settled serving-unit records after idle exit and recreation (I2, I10)", () => {
	const base = { ...initial(1, 2), historyLimit: 2 }
	const done = Arr.reduce(
		Arr.makeBy(6, (i) => `change-${i + 1}`),
		base,
		(s, id) => {
			const accepted = accept(submit(s), id)
			return exit(
				accepted,
				Option.getOrThrow(Core.cell(accepted, "instance-0").value),
			)
		},
	)
	assert.strictEqual(HashMap.size(done.changes), 2)
	assert.isAtMost(HashMap.size(done.units), 2)
	capacity(done)
})

it("reclaims an orphaned ended current unit when unrelated history already evicted its Change (I2, I10)", () => {
	const base = { ...initial(), historyLimit: 1 }
	const a = accept(submit(base), "change-1")
	const dead = exit(a, Option.getOrThrow(Core.cell(a, "instance-0").value))
	const b = accept(submit(dead, request(dead, "instance-1")), "change-2")
	assert.isTrue(Option.isNone(Core.get(b, "change-1")))
	const replacement = accept(submit(b), "change-3")
	assert.strictEqual(HashMap.size(replacement.units), 2)
	assert.isTrue(oneMember(status(replacement, "change-3")).healthy)
	capacity(replacement)
})
