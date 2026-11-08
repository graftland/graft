import { Array as Arr, Cause, Equal, HashMap, HashSet, Option } from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore.ts"
import { capacity } from "./change-model/assertions.ts"
import {
	accept,
	conclusion,
	exit,
	fire,
	initial,
	pending,
	report,
	request,
	status,
	submit,
	succeed,
} from "./change-model/scenarios.ts"
import { declaredMembers, oneMember } from "./member-fact"

describe("production decision core", () => {
	it("records intent, a fresh term and capacity before dispatch (I1, I2, I5)", () => {
		const s = succeed(submit(initial()), "change-1", "Resolve")
		const command = pending(s, "change-1", "Spawn")
		const unit = Option.getOrThrow(HashMap.get(s.units, command.unit))
		assert.strictEqual(unit.evidence, "Missing")
		assert.strictEqual(unit.phase, "PendingSpawn")
		assert.strictEqual(
			Option.getOrThrow(HashMap.get(unit.members, "instance-0")).term,
			1,
		)
		assert.isTrue(
			Option.contains(
				Option.getOrThrow(HashMap.get(s.claims, unit.claim)).unit,
				unit.id,
			),
		)
		capacity(s)
	})

	it("preserves independent patches in both commit orders (I3; snapshot replacement counterexample)", () => {
		const base = initial()
		const admitted = submit(submit(base), request(base, "instance-1"))
		for (const order of [
			["change-1", "change-2"],
			["change-2", "change-1"],
		]) {
			const done = Arr.reduce(order, admitted, accept)
			assert.strictEqual(conclusion(done, "change-1").outcome, "Accepted")
			assert.strictEqual(conclusion(done, "change-2").outcome, "Accepted")
			assert.strictEqual(
				oneMember(status(done)).actual.pipe(
					Option.map((t) => t.identity),
					Option.getOrUndefined,
				),
				"next",
			)
			assert.strictEqual(
				oneMember(status(done, "change-2")).actual.pipe(
					Option.map((t) => t.identity),
					Option.getOrUndefined,
				),
				"next",
			)
			capacity(done)
		}
	})

	it("reserves every conflict object atomically and rejects absence ABA (I3)", () => {
		const base = initial()
		const key = "slot:optional"
		const a = {
			...request(base),
			reads: HashMap.set(request(base).reads, key, 0),
		}
		const held = submit(base, a)
		const b = {
			...request(base, "instance-1"),
			reads: HashMap.set(request(base, "instance-1").reads, key, 0),
			writes: HashSet.make("instance-1", key),
		}
		const rejected = Core.reduce(held, { _tag: "Submit", request: b, now: 0 })
		assert.strictEqual(rejected.reply._tag, "Rejected")
		assert.strictEqual(HashMap.size(rejected.state.changes), 1)
		const present = accept(submit(base, b), "change-1")
		const absent = Core.reduce(present, {
			_tag: "Invalidated",
			object: key,
			cause: Cause.fail("Withdrawn"),
			now: 0,
		}).state
		assert.strictEqual(Core.cell(absent, key).version, 2)
		const stale = Core.reduce(absent, {
			_tag: "Submit",
			request: a,
			now: absent.now,
		})
		assert.deepStrictEqual(stale.reply, {
			_tag: "Rejected",
			reason: "Stale",
			conflicts: HashSet.make(key),
		})
	})

	it("rejects stale, duplicate and reordered command acknowledgements (I1, I8)", () => {
		const submitted = submit(initial())
		const c = pending(submitted, "change-1", "Resolve")
		const done = report(submitted, c)
		assert.isTrue(Equal.equals(done, report(done, c)))
		const bad = Core.reduce(submitted, {
			_tag: "Reported",
			command: c.id,
			token: {
				...c.token,
				members: HashMap.map(c.token.members, (member) => ({
					...member,
					term: 99,
				})),
			},
			result: { _tag: "Succeeded" },
			now: 0,
		})
		assert.isTrue(Equal.equals(submitted, bad.state))
		assert.isTrue(Option.isNone(status(done).conclusion))
	})

	it("never manufactures NotStarted on spawn deadline or termination acknowledgement (I5)", () => {
		const spawning = succeed(submit(initial()), "change-1", "Resolve")
		const spawn = pending(spawning, "change-1", "Spawn")
		const timedOut = fire(spawning, "change-1", "Operation")
		const acknowledged = succeed(timedOut, "change-1", "Terminate")
		assert.strictEqual(
			Option.getOrThrow(HashMap.get(acknowledged.units, spawn.unit)).evidence,
			"Missing",
		)
		const stuck = fire(acknowledged, "change-1", "Evidence")
		assert.strictEqual(conclusion(stuck).outcome, "Stuck")
		assert.isTrue(HashSet.has(status(stuck).unconfirmedUnits, spawn.unit))
		assert.strictEqual(Core.capacity(stuck).used, 3)
		capacity(stuck)
	})

	it("accepts NotStarted only as confirmed prevention tied to the spawn intent (I5)", () => {
		const spawning = succeed(submit(initial()), "change-1", "Resolve")
		const c = pending(spawning, "change-1", "Spawn")
		const failed = report(spawning, c, {
			_tag: "Failed",
			cause: Cause.fail("Creation prevented"),
			creation: "NotStarted",
		})
		assert.strictEqual(conclusion(failed).outcome, "Aborted")
		assert.strictEqual(Core.capacity(failed).used, 2)
		assert.strictEqual(Core.capacity(failed).reserved, 0)
	})

	it("keeps Stuck local, releases exact late claims once, and preserves its conclusion (I2, I3, I10)", () => {
		const spawning = succeed(submit(initial()), "change-1", "Resolve")
		const c = pending(spawning, "change-1", "Spawn")
		const stuck = fire(
			fire(spawning, "change-1", "Operation"),
			"change-1",
			"Evidence",
		)
		const original = conclusion(stuck)
		const independent = accept(
			submit(stuck, request(stuck, "instance-1")),
			"change-2",
		)
		assert.strictEqual(conclusion(independent, "change-2").outcome, "Accepted")
		const late = exit(independent, c.unit)
		const twice = exit(late, c.unit)
		assert.strictEqual(conclusion(twice), original)
		assert.isTrue(Equal.equals(Core.capacity(late), Core.capacity(twice)))
		assert.isTrue(Option.isNone(Core.cell(twice, "instance-0").writer))
		capacity(twice)
	})

	it("settles only the exited unit leases and keeps cleanup separate (I2, I6)", () => {
		const base = initial()
		const r = { ...request(base), leases: HashSet.make("instance-1@0") }
		const spawning = succeed(submit(base, r), "change-1", "Resolve")
		const c = pending(spawning, "change-1", "Spawn")
		const cancelled = Core.reduce(spawning, {
			_tag: "Cancel",
			change: "change-1",
			cause: Cause.fail("Cancelled"),
			now: 0,
		}).state
		assert.strictEqual(HashSet.size(status(cancelled).leaseHolders), 1)
		const ended = exit(cancelled, c.unit)
		assert.strictEqual(HashSet.size(status(ended).leaseHolders), 0)
		assert.strictEqual(
			Option.getOrThrow(HashMap.get(ended.units, c.unit)).cleanup._tag,
			"Unknown",
		)
		assert.strictEqual(conclusion(ended).outcome, "Aborted")
	})

	it("records old-changed before Stop and recovers exclusively with a fresh full trial (I7, I11)", () => {
		const base = initial(1, 1)
		const admitted = submit(base, request(base, "instance-0", "Restart"))
		const stop = pending(admitted, "change-1", "Stop")
		assert.isTrue(status(admitted).oldChanged)
		assert.isFalse(
			Arr.some(
				Arr.fromIterable(HashMap.values(admitted.commands)),
				(c) => c.kind === "Spawn",
			),
		)
		const stopped = exit(admitted, stop.unit)
		const spawning = succeed(stopped, "change-1", "Resolve")
		const candidate = pending(spawning, "change-1", "Spawn")
		const failed = report(spawning, candidate, {
			_tag: "Failed",
			creation: "NotStarted",
			cause: Cause.fail("Candidate unavailable"),
		})
		const resolved = succeed(failed, "change-1", "Resolve")
		assert.strictEqual(
			pending(resolved, "change-1", "Spawn").target.identity,
			"original",
		)
		const trial = succeed(
			Arr.reduce(
				[
					"Spawn",
					"Start",
					"Serve",
					"Ready",
					"Probe",
				] satisfies ReadonlyArray<Core.CommandKind>,
				resolved,
				(s, kind) => succeed(s, "change-1", kind),
			),
			"change-1",
			"Install",
		)
		assert.isTrue(Option.isNone(status(trial).conclusion))
		const recovered = fire(trial, "change-1", "Trial")
		assert.strictEqual(conclusion(recovered).outcome, "Recovered")
		assert.strictEqual(
			oneMember(status(recovered)).actual.pipe(
				Option.map((t) => t.identity),
				Option.getOrUndefined,
			),
			"original",
		)
		assert.strictEqual(
			Option.getOrThrow(HashMap.get(recovered.instances, "instance-0")).term,
			2,
		)
		capacity(recovered)
	})

	it("does not reuse revoked recovery authorization or overwrite a lost owned version (I3, I7)", () => {
		const s = submit(initial(), request(initial(), "instance-0", "Restart"))
		const stop = pending(s, "change-1", "Stop")
		const stopped = exit(s, stop.unit)
		const failed = report(stopped, pending(stopped, "change-1", "Resolve"), {
			_tag: "Failed",
			cause: Cause.fail("Candidate denied"),
			creation: "Unknown",
		})
		const denied = report(failed, pending(failed, "change-1", "Resolve"), {
			_tag: "Failed",
			cause: Cause.fail("Recovery revoked"),
			creation: "Unknown",
		})
		assert.strictEqual(conclusion(denied).outcome, "RecoveryFailed")
		assert.isFalse(oneMember(status(denied)).healthy)
		assert.isAtLeast(conclusion(denied).cause.reasons.length, 2)
	})

	it("does not rewrite a conclusion or its transferred serving owner after idle exit and recreation (I10)", () => {
		const accepted = accept(submit(initial()), "change-1")
		const old = conclusion(accepted)
		const serving = Option.getOrThrow(
			Option.flatMap(
				HashMap.get(accepted.instances, "instance-0"),
				(instance) => instance.current,
			),
		)
		const dead = exit(accepted, serving)
		assert.strictEqual(conclusion(dead), old)
		assert.isFalse(oneMember(status(dead)).healthy)
		const recreated = accept(submit(dead), "change-2")
		const late = exit(recreated, serving)
		assert.strictEqual(conclusion(late), old)
		assert.isTrue(oneMember(status(late)).healthy)
		assert.strictEqual(
			oneMember(status(late)).actual.pipe(
				Option.map((t) => t.identity),
				Option.getOrUndefined,
			),
			"next",
		)
		capacity(late)
	})

	it("preserves the full original command and cleanup causes (I1, I6)", () => {
		const spawning = succeed(submit(initial()), "change-1", "Resolve")
		const c = pending(spawning, "change-1", "Spawn")
		const cause = Cause.combine(
			Cause.fail("First failure"),
			Cause.die({ detail: "Second failure" }),
		)
		const failed = report(spawning, c, {
			_tag: "Failed",
			cause,
			creation: "Unknown",
		})
		const ended = exit(failed, c.unit, {
			_tag: "Failed",
			cause: Cause.die("Cleanup failed"),
		})
		assert.strictEqual(conclusion(ended).outcome, "Aborted")
		assert.strictEqual(conclusion(ended).cause.reasons.length, 3)
		// Spawn creation was unknown and the unit then exited: the attempt reports a stopped member.
		const member = oneMember(conclusion(ended))
		assert.strictEqual(member.attempt, "Stopped")
		assert.isTrue(member.startingHealthy)
		assert.isTrue(
			Equal.equals(
				Option.getOrThrow(HashMap.get(ended.commands, c.id)).report,
				Option.some({ _tag: "Failed", cause, creation: "Unknown" }),
			),
		)
	})

	it("closes admission and never reports Aborted after shutdown stops old execution (I7)", () => {
		const s = submit(initial())
		const closing = Core.reduce(s, { _tag: "Shutdown", now: 0 }).state
		const stop = pending(closing, "change-1", "Terminate")
		const ended = exit(closing, stop.unit)
		assert.strictEqual(conclusion(ended).outcome, "RecoveryFailed")
		assert.strictEqual(
			Core.reduce(ended, { _tag: "Submit", request: request(ended), now: 0 })
				.reply._tag,
			"Rejected",
		)
		assert.isFalse(
			Arr.some(
				Arr.fromIterable(HashMap.values(ended.commands)),
				(c) => c.kind === "Resolve" && c.disposition === "Pending",
			),
		)
	})

	it("rejects runner Overlap before execution (I3, I5)", () => {
		const s = initial()
		const r = request(s)
		for (const bad of Arr.make({
			...r,
			target: { ...r.target, placement: "Runner" } satisfies Core.Target,
			proposal: {
				members: Arr.map(
					declaredMembers([{ id: "instance-0", target: r.target }]),
					(m) => ({
						...m,
						placement: Option.some<Core.PlacementRequirement>({
							kind: "Runner",
						}),
					}),
				),
				explicit: HashSet.make("instance-0"),
				removed: HashSet.empty(),
				realms: [],
			},
		})) {
			const result = Core.reduce(s, { _tag: "Submit", request: bad, now: 0 })
			assert.strictEqual(result.reply._tag, "Rejected")
			assert.strictEqual(HashMap.size(result.state.changes), 0)
			assert.strictEqual(HashMap.size(result.state.commands), 0)
		}
	})
})
