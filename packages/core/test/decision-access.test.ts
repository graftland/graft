import { Array, Cause, HashMap, HashSet, Option } from "effect"
import type * as EffectModule from "effect"
import { assert, it } from "@effect/vitest"

import { vi } from "vitest"

import * as Core from "../src/internal/decisionCore"
import {
	exitEvent,
	initial,
	reportEvent,
	request,
	timerEvent,
} from "./change-model/scenarios"
import { measure } from "./decision-access"

vi.mock("effect", (importOriginal) =>
	importOriginal<typeof EffectModule>().then((original) => ({
		...original,
		Array: {
			...original.Array,
			fromIterable: vi.fn(original.Array.fromIterable),
		},
		HashMap: {
			...original.HashMap,
			get: vi.fn(original.HashMap.get),
			has: vi.fn(original.HashMap.has),
			keys: vi.fn(original.HashMap.keys),
			values: vi.fn(original.HashMap.values),
			entries: vi.fn(original.HashMap.entries),
			toEntries: vi.fn(original.HashMap.toEntries),
			reduce: vi.fn(original.HashMap.reduce),
			map: vi.fn(original.HashMap.map),
			filter: vi.fn(original.HashMap.filter),
			forEach: vi.fn(original.HashMap.forEach),
			set: vi.fn(original.HashMap.set),
			remove: vi.fn(original.HashMap.remove),
			modify: vi.fn(original.HashMap.modify),
			modifyAt: vi.fn(original.HashMap.modifyAt),
			fromIterable: vi.fn(original.HashMap.fromIterable),
		},
		HashSet: {
			...original.HashSet,
			has: vi.fn(original.HashSet.has),
			reduce: vi.fn(original.HashSet.reduce),
			some: vi.fn(original.HashSet.some),
			every: vi.fn(original.HashSet.every),
			map: vi.fn(original.HashSet.map),
			filter: vi.fn(original.HashSet.filter),
			add: vi.fn(original.HashSet.add),
			remove: vi.fn(original.HashSet.remove),
			union: vi.fn(original.HashSet.union),
			fromIterable: vi.fn(original.HashSet.fromIterable),
		},
	})),
)
const kinds: ReadonlyArray<Core.CommandKind> = [
	"Resolve",
	"Spawn",
	"Start",
	"Serve",
	"Ready",
	"Probe",
	"Install",
]
interface Position {
	readonly state: Core.State
	readonly counts: ReadonlyArray<number>
}
const run = (unrelated: number) => {
	const base = initial(unrelated + 1, 3 * unrelated + 10)
	const busy = Array.reduce(
		Array.makeBy(unrelated, (i) => i + 1),
		base,
		(state, i) => {
			const next = Core.reduce(state, {
				_tag: "Submit",
				request: request(state, "instance-" + i),
				now: state.now,
			}).state
			vi.clearAllMocks()
			return next
		},
	)
	const forbidden = HashSet.fromIterable(
		Array.flatMap(Array.fromIterable(HashMap.values(busy.changes)), (c) => [
			c.id,
			c.request.instance,
			"instance:" + c.request.instance,
			c.request.instance + "@0",
			...c.claims,
			...c.units,
			...c.timerIds,
		]),
	)
	const step = (position: Position, event: Core.Event): Position => {
		const trace = measure(position.state, () =>
			Core.reduce(position.state, event),
		)
		assert.deepEqual(trace.scans, [])
		assert.isFalse(
			Array.some(trace.visits, (v) => HashSet.has(forbidden, v.key)),
		)
		return {
			state: trace.value.state,
			counts: Array.append(position.counts, trace.visits.length),
		}
	}
	const admitted = step(
		{ state: busy, counts: [] },
		{
			_tag: "Submit",
			request: request(busy, "instance-0", "Restart"),
			now: busy.now,
		},
	)
	const id = Option.getOrThrow(
		HashMap.get(admitted.state.changes, "change-" + (unrelated + 1)),
	).id
	const oldStop = reportEvent(admitted.state, id, "Stop")
	const retired = step(admitted, exitEvent(admitted.state, "instance-0@0"))
	const serving = Array.reduce(kinds, retired, (r, kind) =>
		step(r, reportEvent(r.state, id, kind)),
	)
	const change = Option.getOrThrow(HashMap.get(serving.state.changes, id))
	const candidate = Option.getOrThrow(
		HashMap.get(serving.state.units, Option.getOrThrow(change.candidate)),
	)
	const failed = step(serving, {
		_tag: "UnitFailed",
		unit: candidate.id,
		incarnation: candidate.incarnation,
		observer: candidate.spawn,
		cause: Cause.fail("Trial failed"),
		now: serving.state.now,
	})
	const ended = step(failed, exitEvent(failed.state, candidate.id))
	const recovered = Array.reduce(kinds, ended, (r, kind) =>
		step(r, reportEvent(r.state, id, kind)),
	)
	const accepted = step(recovered, timerEvent(recovered.state, id, "Trial"))
	const lateReport = step(accepted, { ...oldStop, now: accepted.state.now })
	const lateExit = step(lateReport, exitEvent(lateReport.state, "instance-0@0"))
	const observation = measure(lateExit.state, () =>
		Core.get(lateExit.state, id),
	)
	assert.deepEqual(observation.scans, [])
	assert.isFalse(
		Array.some(observation.visits, (v) => HashSet.has(forbidden, v.key)),
	)
	const status = Option.getOrThrow(observation.value)
	assert.equal(Option.getOrThrow(status.conclusion).outcome, "Recovered")
	assert.equal(HashSet.size(status.unconfirmedUnits), 0)
	assert.equal(HashSet.size(lateExit.state.active), unrelated)
	return Array.append(lateExit.counts, observation.visits.length)
}
it("observes actual production collection accesses across admission, commit, recovery, settlement and get with 2000 unrelated active Changes (I1, I2, I3, I10)", () => {
	const alone = run(0)
	const concurrent = run(2000)
	assert.deepEqual(concurrent, alone)
	assert.equal(concurrent.length, 22)
}, 30000)

it("detects a whole-index read after an immutable write instead of trusting declared cell touches", () => {
	const state = initial(20)
	const instance = Option.getOrThrow(HashMap.get(state.instances, "instance-0"))
	const enumeration = measure(state, () =>
		Array.fromIterable(
			HashMap.values(HashMap.set(state.instances, "instance-0", instance)),
		),
	)
	assert.include(enumeration.scans, "Map.values:instances")
	const lookup = measure(state, () =>
		HashMap.get(state.instances, "instance-19"),
	)
	assert.isTrue(
		Array.some(
			lookup.visits,
			(v) => v.collection === "instances" && v.key === "instance-19",
		),
	)
})
