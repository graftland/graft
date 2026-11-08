import { Array as Arr, Cause, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore.ts"
import { checked, invariant } from "./change-model/assertions.ts"
import { explore, reachable, type Stimulus } from "./change-model/explore.ts"
import {
	conclusion,
	exitEvent,
	initial,
	installed,
	pending,
	report,
	reportEvent,
	request,
	status,
	submit,
	timerEvent,
} from "./change-model/scenarios.ts"
import { oneMember } from "./member-fact"

const reportStimulus = (id: string, kind: Core.CommandKind): Stimulus => ({
	name: `${id}:${kind}`,
	event: (s) => reportEvent(s, id, kind),
})
const forward = (id: string, instance: string): ReadonlyArray<Stimulus> => [
	...Arr.map(
		[
			"Resolve",
			"Spawn",
			"Start",
			"Serve",
			"Ready",
			"Probe",
			"Install",
		] satisfies ReadonlyArray<Core.CommandKind>,
		(kind) => reportStimulus(id, kind),
	),
	{ name: `${id}:Trial`, event: (s) => timerEvent(s, id, "Trial") },
	{ name: `${id}:OldExit`, event: (s) => exitEvent(s, `${instance}@0`) },
]

it("explores every causal shuffle of independent Changes using production commands (I1, I2, I3, I6)", () => {
	const base = initial()
	const s = submit(submit(base), request(base, "instance-1"))
	const stats = explore(
		s,
		[forward("change-1", "instance-0"), forward("change-2", "instance-1")],
		(s) => {
			assert.strictEqual(conclusion(s).outcome, "Accepted")
			assert.strictEqual(conclusion(s, "change-2").outcome, "Accepted")
			assert.strictEqual(Core.cell(s, "instance-0").version, 2)
			assert.strictEqual(Core.cell(s, "instance-1").version, 2)
		},
	)
	assert.strictEqual(stats.schedules, 48620)
	assert.strictEqual(stats.states, stats.transitions + 1)
	assert.strictEqual(stats.states, 184755)
	assert.strictEqual(stats.transitions, 184754)
}, 60000)

it("explores conflicting admission and shutdown in every causal order (I2, I3, I7)", () => {
	const base = initial()
	const a = request(base)
	const b = {
		...request(base, "instance-1"),
		reads: HashMap.set(request(base, "instance-1").reads, "instance-0", 1),
		writes: HashSet.make("instance-0", "instance-1"),
	}
	const stats = explore(
		base,
		[
			[
				{
					name: "Submit A",
					event: (s) => ({ _tag: "Submit", request: a, now: s.now }),
				},
			],
			[
				{
					name: "Submit B",
					event: (s) => ({ _tag: "Submit", request: b, now: s.now }),
				},
			],
			[{ name: "Shutdown", event: (s) => ({ _tag: "Shutdown", now: s.now }) }],
		],
		(s) => {
			assert.isFalse(s.open)
			assert.isAtMost(HashMap.size(s.changes), 1)
			invariant(s)
		},
	)
	assert.deepStrictEqual(stats, { schedules: 6, states: 16, transitions: 15 })
})

it("explores exclusive recovery alongside an unrelated commit without overwriting it (I3, I7, I11)", () => {
	const base = initial()
	const both = submit(submit(base), request(base, "instance-1"))
	const inTrial = installed(installed(both, "change-1"), "change-2")
	const cancelled = Core.reduce(inTrial, {
		_tag: "Cancel",
		change: "change-1",
		cause: Cause.fail("Trial failed"),
		now: inTrial.now,
	}).state
	const settledOld = Core.reduce(
		cancelled,
		exitEvent(cancelled, "instance-0@0"),
	).state
	const recovering = Core.reduce(
		settledOld,
		exitEvent(settledOld, "instance-0@1"),
	).state
	const stats = explore(
		recovering,
		[
			[
				...Arr.map(
					[
						"Resolve",
						"Spawn",
						"Start",
						"Serve",
						"Ready",
						"Probe",
						"Install",
					] satisfies ReadonlyArray<Core.CommandKind>,
					(kind) => reportStimulus("change-1", kind),
				),
				{
					name: "Recovery trial",
					event: (s) => timerEvent(s, "change-1", "Trial"),
				},
			],
			[
				{ name: "B trial", event: (s) => timerEvent(s, "change-2", "Trial") },
				{ name: "B exit", event: (s) => exitEvent(s, "instance-1@0") },
			],
		],
		(s) => {
			assert.strictEqual(conclusion(s).outcome, "Recovered")
			assert.strictEqual(conclusion(s, "change-2").outcome, "Accepted")
			assert.strictEqual(
				Option.getOrThrow(oneMember(status(s)).actual).identity,
				"original",
			)
			assert.strictEqual(
				Option.getOrThrow(oneMember(status(s, "change-2")).actual).identity,
				"next",
			)
		},
	)
	assert.strictEqual(stats.schedules, 45)
	assert.deepStrictEqual(stats, {
		schedules: 45,
		states: 219,
		transitions: 218,
	})
})

it("explores repeated exit, timer, failure, cancellation and shutdown reports to depth four (I1, I2, I5, I10)", () => {
	const spawned = report(
		submit(initial()),
		pending(submit(initial()), "change-1", "Resolve"),
	)
	const spawn = pending(spawned, "change-1", "Spawn")
	const oldTimer = timerEvent(spawned, "change-1", "Operation")
	const alphabet: ReadonlyArray<Stimulus> = [
		{
			name: "Spawn success",
			event: (s) => ({
				_tag: "Reported",
				command: spawn.id,
				token: spawn.token,
				result: { _tag: "Succeeded" },
				now: s.now,
			}),
		},
		{
			name: "Command failure",
			event: (s) => ({
				_tag: "Reported",
				command: spawn.id,
				token: spawn.token,
				result: {
					_tag: "Failed",
					cause: Cause.fail("Spawn failed"),
					creation: "Unknown",
				},
				now: s.now,
			}),
		},
		{ name: "Exit", event: (s) => exitEvent(s, spawn.unit) },
		{ name: "Timer", event: () => oldTimer },
		{
			name: "Cancel",
			event: (s) => ({
				_tag: "Cancel",
				change: "change-1",
				cause: Cause.fail("Cancelled"),
				now: s.now,
			}),
		},
		{ name: "Shutdown", event: (s) => ({ _tag: "Shutdown", now: s.now }) },
	]
	const stats = reachable(spawned, alphabet, 4)
	assert.isAbove(HashSet.size(stats.states), 50)
	for (const s of stats.states) invariant(s)
	assert.strictEqual(HashSet.size(stats.states), 238)
	assert.strictEqual(stats.transitions, 648)
})

it("detects a lost owned version before recovery and retains the conflicting accepted state (I3, I7)", () => {
	const s = installed(submit(initial()), "change-1")
	const invalid = checked(s, {
		_tag: "Invalidated",
		object: "instance-0",
		cause: Cause.fail("Owned version lost"),
		now: s.now,
	}).state
	const old = checked(invalid, exitEvent(invalid, "instance-0@0")).state
	const ended = checked(old, exitEvent(old, "instance-0@1")).state
	assert.strictEqual(conclusion(ended).outcome, "RecoveryFailed")
	assert.strictEqual(Core.cell(ended, "instance-0").version, 3)
	assert.isTrue(Option.isNone(Core.cell(ended, "instance-0").value))
})
