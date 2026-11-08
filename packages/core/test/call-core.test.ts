import { Array, Cause, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import {
	complete,
	observe,
	one,
	requested,
	result,
	setup,
} from "./call-fixture"
import { exit, fire, request, succeed } from "./change-model/scenarios"

it("records the selected provider and credit before sending a grant (I1, I2, I8, I9)", () => {
	const s = requested()
	const c = one(s)
	assert.isTrue(c.credit)
	assert.equal(c.provider, "provider@0")
	assert.equal(c.consumer, "consumer@0")
	const register = Array.findFirst(
		HashMap.values(s.commands),
		(c) => c.kind === "CallRegister",
	).pipe(Option.getOrThrow)
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(s.commands)),
			(c) => c.kind === "CallGrant",
		),
	)
	const registered = Core.reduce(s, {
		_tag: "Reported",
		command: register.id,
		token: register.token,
		result: { _tag: "Succeeded" },
		now: 0,
	})
	assert.isTrue(Array.some(registered.commands, (c) => c.kind === "CallGrant"))
})
it("retains execution credit after result and cancellation until owned completion (I2, I9)", () => {
	const s = result(requested())
	const cancelled = observe(s, {
		_tag: "Cancel",
		session: "session-a",
		request: "1",
	})
	assert.equal(one(cancelled).result, "Received")
	assert.isTrue(one(cancelled).cancelled)
	assert.isTrue(one(cancelled).credit)
	assert.isFalse(one(complete(cancelled)).credit)
})
it("deduplicates completion and never reexecutes the same session request (I2, I9)", () => {
	const s = complete(requested())
	const twice = complete(s)
	assert.isFalse(one(twice).credit)
	const repeated = requested(twice)
	assert.equal(HashMap.size(repeated.calls), 1)
	assert.equal(
		Array.filter(
			Array.fromIterable(HashMap.values(repeated.commands)),
			(c) => c.kind === "CallRegister",
		).length,
		1,
	)
})
it("keeps reused request ids in different sessions independent (I2, I9)", () => {
	const s = requested(requested(), "session-b")
	assert.equal(HashMap.size(s.calls), 2)
	const key = Array.findFirst(
		HashMap.values(s.calls),
		(c) => c.session === "session-a",
	).pipe(Option.getOrThrow).key
	const done = complete(s, key)
	assert.isTrue(
		Array.findFirst(
			HashMap.values(done.calls),
			(c) => c.session === "session-b",
		).pipe(Option.getOrThrow).credit,
	)
})
it("does not release provider execution when the consumer or an unrelated unit exits (I5, I9)", () => {
	const s = requested()
	assert.isTrue(one(exit(s, "consumer@0")).credit)
	assert.isTrue(one(exit(s, "other@0")).credit)
	const stopped = exit(s, "provider@0")
	assert.isFalse(one(stopped).credit)
	assert.equal(one(stopped).result, "Unknown")
})
it("retains credit on disconnect and rejects stale provider completion evidence (I5, I9)", () => {
	const s = requested()
	const c = one(s)
	const forged = observe(
		s,
		{
			_tag: "Complete",
			key: c.key,
			cleanup: { _tag: "Completed" },
			cause: Cause.empty,
		},
		"other@0",
	)
	assert.isTrue(one(forged).credit)
	const u = HashMap.get(s.units, "provider@0").pipe(Option.getOrThrow)
	const disconnected = Core.reduce(s, {
		_tag: "UnitDisconnected",
		unit: u.id,
		incarnation: u.incarnation,
		observer: u.spawn,
		cause: Cause.fail("Disconnected"),
		now: 0,
	}).state
	assert.isTrue(one(disconnected).credit)
})
it("rejects nested business dispatch and saturation without losing existing credit (I9, I12)", () => {
	const s = { ...setup(), callLimits: { concurrency: 1, waiters: 1, wait: 50 } }
	const active = requested(s)
	const overflow = requested(active, "session-b")
	assert.equal(HashMap.size(overflow.calls), 1)
	assert.isTrue(
		Array.some(
			Array.fromIterable(HashMap.values(overflow.commands)),
			(c) => c.kind === "CallReject" && c.call?.reason === "Saturated",
		),
	)
	const nested = observe(setup(), {
		_tag: "Request",
		session: "nested",
		request: "1",
		service: "weather",
		lifecycle: false,
		nested: true,
		wait: 50,
	})
	assert.equal(HashMap.size(nested.calls), 0)
})
it("expires or cancels Restart waiters before dispatch without creating execution credit (I8, I9, I11)", () => {
	const paused = {
		...setup(),
		instances: HashMap.modify(setup().instances, "provider", (i) => ({
			...i,
			healthy: false,
		})),
	}
	const queued = requested(paused)
	assert.equal(HashMap.size(queued.calls), 0)
	assert.equal(HashMap.size(queued.callWaiters), 1)
	const key = Array.head(
		Array.fromIterable(HashMap.keys(queued.callWaiters)),
	).pipe(Option.getOrThrow)
	const expired = Core.reduce(queued, {
		_tag: "CallExpired",
		key,
		now: 50,
	}).state
	assert.equal(HashMap.size(expired.callWaiters), 0)
	assert.equal(HashMap.size(expired.calls), 0)
	const cancelled = observe(queued, {
		_tag: "Cancel",
		session: "session-a",
		request: "1",
	})
	assert.equal(HashMap.size(cancelled.callWaiters), 0)
})
it("preserves a completion defect and unknown cleanup separately from business receipt (I6, I9)", () => {
	const s = result(requested())
	const done = observe(
		s,
		{
			_tag: "Complete",
			key: one(s).key,
			cleanup: { _tag: "Failed", cause: Cause.die("Finalizer defect") },
			cause: Cause.interrupt(),
		},
		"provider@0",
	)
	assert.equal(one(done).result, "Received")
	assert.isFalse(one(done).credit)
	assert.isTrue(Cause.hasDies(one(done).cause))
	assert.isTrue(Cause.hasInterrupts(one(done).cause))
})

const retiring = () => {
	const s = requested()
	const admitted = Core.reduce(s, {
		_tag: "Submit",
		request: request(s, "provider"),
		now: 0,
	}).state
	const ready = Array.reduce(
		[
			"Resolve",
			"Spawn",
			"Start",
			"Serve",
			"Ready",
			"Probe",
			"Install",
		] satisfies ReadonlyArray<Core.CommandKind>,
		admitted,
		(s, kind) => succeed(s, "change-1", kind),
	)
	return fire(ready, "change-1", "Trial")
}
it("drains core credits before stopping an old provider despite a received result (I8, I9)", () => {
	const s = result(retiring())
	assert.equal(Option.getOrThrow(Core.get(s, "change-1")).phase, "Draining")
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(s.commands)),
			(c) => c.kind === "Stop" && c.unit === "provider@0",
		),
	)
	const done = complete(s)
	assert.isTrue(
		Array.some(
			Array.fromIterable(HashMap.values(done.commands)),
			(c) => c.kind === "Stop" && c.unit === "provider@0",
		),
	)
})
it("uses the drain deadline to request cancellation and stop, never to release credit (I5, I9, I11)", () => {
	const s = fire(retiring(), "change-1", "Operation")
	assert.isTrue(one(s).credit)
	assert.isTrue(
		Array.some(
			Array.fromIterable(HashMap.values(s.commands)),
			(c) => c.kind === "CallCancel",
		),
	)
	const exited = exit(s, "provider@0")
	assert.isFalse(one(exited).credit)
	assert.equal(
		Option.getOrThrow(
			Option.getOrThrow(Core.get(exited, "change-1")).conclusion,
		).outcome,
		"Accepted",
	)
})
it("retains a lost completion until provider exit and keeps a published Stuck immutable (I5, I9, I10)", () => {
	const stopping = fire(retiring(), "change-1", "Operation")
	const forced = fire(stopping, "change-1", "Operation")
	const stuck = fire(forced, "change-1", "Evidence")
	const before = Option.getOrThrow(Core.get(stuck, "change-1"))
	assert.equal(Option.getOrThrow(before.conclusion).outcome, "Stuck")
	assert.equal(HashSet.size(before.outstandingCalls), 1)
	const after = Option.getOrThrow(
		Core.get(exit(stuck, "provider@0"), "change-1"),
	)
	assert.strictEqual(before.conclusion, after.conclusion)
	assert.equal(HashSet.size(after.outstandingCalls), 0)
})

it("does not erase known owned cleanup failure when the provider later exits (I6, I9)", () => {
	const s = retiring()
	const failed = observe(
		s,
		{
			_tag: "Complete",
			key: one(s).key,
			cleanup: { _tag: "Failed", cause: Cause.die("Owned cleanup defect") },
			cause: Cause.empty,
		},
		"provider@0",
	)
	const ended = exit(failed, "provider@0")
	const c = HashMap.get(ended.changes, "change-1").pipe(Option.getOrThrow)
	assert.isTrue(c.failure || c.recovering)
	assert.include(Cause.pretty(c.cause), "Owned cleanup defect")
	assert.isFalse(Option.exists(c.conclusion, (c) => c.outcome === "Accepted"))
})

it("retires consumer channel resources only after exact provider exit (I2, I5, I8)", () => {
	const s = requested()
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(s.commands)),
			(c) => c.kind === "RetireRoute",
		),
	)
	const ended = exit(s, "provider@0")
	const retired = Array.findFirst(
		HashMap.values(ended.commands),
		(c) => c.kind === "RetireRoute",
	).pipe(Option.getOrThrow)
	assert.equal(retired.unit, "consumer@0")
	assert.equal(retired.call?.key, "calls/provider@0")
})

it("retains control command failures without releasing or retrying registered execution (I1, I5, I9)", () => {
	const s = requested()
	const register = Array.findFirst(
		HashMap.values(s.commands),
		(c) => c.kind === "CallRegister",
	).pipe(Option.getOrThrow)
	const failed = Core.reduce(s, {
		_tag: "Reported",
		command: register.id,
		token: register.token,
		result: {
			_tag: "Failed",
			cause: Cause.die("Register delivery unknown"),
			creation: "Unknown",
		},
		now: 0,
	}).state
	assert.isTrue(one(failed).credit)
	assert.equal(one(failed).result, "Unknown")
	const cancel = Array.findFirst(
		HashMap.values(failed.commands),
		(c) => c.kind === "CallCancel",
	).pipe(Option.getOrThrow)
	const lost = Core.reduce(failed, {
		_tag: "Reported",
		command: cancel.id,
		token: cancel.token,
		result: {
			_tag: "Failed",
			cause: Cause.fail("Cancel delivery unknown"),
			creation: "Unknown",
		},
		now: 0,
	}).state
	assert.include(Cause.pretty(one(lost).cause), "Register delivery unknown")
	assert.include(Cause.pretty(one(lost).cause), "Cancel delivery unknown")
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(lost.commands)),
			(c) => c.kind === "CallGrant",
		),
	)
})
it("records an unknown result on consumer exit even after owned completion (I5, I9)", () => {
	const done = complete(requested())
	const lost = exit(done, "consumer@0")
	assert.isFalse(one(lost).credit)
	assert.equal(one(lost).result, "Unknown")
})

it("does not invent a restoration generation for an instance that has never served (I7, I11)", () => {
	const initial = Core.empty({
		authority: "new-instance",
		maxUnits: 2,
		instances: [
			{
				id: "provider",
				target: { identity: "first", placement: "Worker", overlap: true },
			},
		],
	})
	const submitted = Core.reduce(initial, {
		_tag: "Submit",
		request: request(initial, "provider"),
		now: 0,
	}).state
	const running = succeed(
		succeed(submitted, "change-1", "Resolve"),
		"change-1",
		"Spawn",
	)
	const failed = Core.reduce(running, {
		_tag: "Cancel",
		change: "change-1",
		cause: Cause.fail("First startup failed"),
		now: 0,
	}).state
	const settled = exit(failed, "provider@1")
	const c = HashMap.get(settled.changes, "change-1").pipe(Option.getOrThrow)
	assert.equal(Option.getOrThrow(c.conclusion).outcome, "RecoveryFailed")
	assert.isFalse(c.recovering)
})
it("keeps data-channel loss Unknown and outstanding until owned completion (I5, I9)", () => {
	const s = result(requested())
	const lost = observe(s, {
		_tag: "Lost",
		session: "session-a",
		request: "1",
		cause: Cause.fail("Socket lost"),
	})
	assert.isTrue(one(lost).credit)
	assert.equal(one(lost).result, "Received")
	assert.include(Cause.pretty(one(lost).cause), "Socket lost")
	const withoutResult = observe(requested(), {
		_tag: "Lost",
		session: "session-a",
		request: "1",
		cause: Cause.fail("Socket lost"),
	})
	assert.equal(one(withoutResult).result, "Unknown")
	assert.isTrue(one(withoutResult).credit)
})

it("projects recovery authorization from the actual generation under the current policy (I1, I7)", () => {
	const initial = setup()
	const admitted = Core.reduce(initial, {
		_tag: "Submit",
		request: request(initial, "provider"),
		now: 0,
	}).state
	const trial = Array.reduce(
		[
			"Resolve",
			"Spawn",
			"Start",
			"Serve",
			"Ready",
			"Probe",
			"Install",
		] satisfies ReadonlyArray<Core.CommandKind>,
		admitted,
		(s, kind) => succeed(s, "change-1", kind),
	)
	const invalid = Core.reduce(trial, {
		_tag: "PolicyChanged",
		instance: "provider",
		allowed: ["provider"],
		values: {},
		now: 0,
	}).state
	const recovering = exit(exit(invalid, "provider@1"), "provider@0")
	const serving = Array.reduce(
		[
			"Resolve",
			"Spawn",
			"Start",
			"Serve",
			"Ready",
			"Probe",
			"Install",
		] satisfies ReadonlyArray<Core.CommandKind>,
		recovering,
		(s, kind) => succeed(s, "change-1", kind),
	)
	const settled = fire(serving, "change-1", "Trial")
	const outcome = Option.getOrThrow(
		Option.getOrThrow(Core.get(settled, "change-1")).conclusion,
	)
	assert.equal(outcome.outcome, "Recovered")
	assert.isTrue(outcome.member.healthy)
})

it("retains cancellation that overtakes admission on the reserved control channel (I2, I8, I9)", () => {
	const cancelled = observe(setup(), {
		_tag: "Cancel",
		session: "session-a",
		request: "1",
	})
	const late = requested(cancelled)
	assert.equal(HashMap.size(late.calls), 0)
	assert.equal(HashMap.size(late.callWaiters), 0)
	assert.isTrue(
		Array.some(
			Array.fromIterable(HashMap.values(late.commands)),
			(c) =>
				c.kind === "CallReject" && c.call?.reason === "CancelledBeforeDispatch",
		),
	)
})
it("removes queued callers once on consumer exit or runtime shutdown (I2, I9)", () => {
	const s = setup()
	const paused = {
		...s,
		instances: HashMap.modify(s.instances, "provider", (i) => ({
			...i,
			healthy: false,
		})),
	}
	const queued = requested(paused)
	assert.equal(HashMap.size(exit(queued, "consumer@0").callWaiters), 0)
	const shutdown = Core.reduce(queued, { _tag: "Shutdown", now: 0 }).state
	assert.equal(HashMap.size(shutdown.callWaiters), 0)
	assert.equal(HashSet.size(shutdown.activeCalls), 0)
})

it("settles only the exited provider's credits across concurrent independent bindings (I2, I6, I9)", () => {
	const s = observe(requested(), {
		_tag: "Request",
		session: "session-b",
		request: "1",
		service: "other",
		lifecycle: false,
		nested: false,
		wait: 50,
	})
	assert.equal(HashSet.size(s.activeCalls), 2)
	const ended = exit(s, "provider@0")
	assert.equal(HashSet.size(ended.activeCalls), 1)
	assert.isTrue(
		Array.findFirst(
			HashMap.values(ended.calls),
			(c) => c.provider === "other@0",
		).pipe(Option.getOrThrow).credit,
	)
})

it("does not attach later instance-owned call failures to a concluded Change that read its provider (I2, I10)", () => {
	const s = setup()
	const r = request(s, "other")
	const admitted = Core.reduce(s, {
		_tag: "Submit",
		request: {
			...r,
			reads: HashMap.set(r.reads, "provider", Core.cell(s, "provider").version),
		},
		now: 0,
	}).state
	const trial = Array.reduce(
		[
			"Resolve",
			"Spawn",
			"Start",
			"Serve",
			"Ready",
			"Probe",
			"Install",
		] satisfies ReadonlyArray<Core.CommandKind>,
		admitted,
		(s, k) => succeed(s, "change-1", k),
	)
	const accepted = exit(fire(trial, "change-1", "Trial"), "other@0")
	const before = HashMap.get(accepted.changes, "change-1").pipe(
		Option.getOrThrow,
	)
	assert.equal(Option.getOrThrow(before.conclusion).outcome, "Accepted")
	const active = requested(accepted)
	const done = observe(
		active,
		{
			_tag: "Complete",
			key: one(active).key,
			cleanup: { _tag: "Completed" },
			cause: Cause.fail("Later business failure"),
		},
		"provider@0",
	)
	const after = HashMap.get(done.changes, "change-1").pipe(Option.getOrThrow)
	assert.strictEqual(before.cause, after.cause)
	assert.strictEqual(before.conclusion, after.conclusion)
})
