import { Cause, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import { one, registered, requested } from "./call-fixture"
import { explore, reachable, type Stimulus } from "./change-model/explore"

const message = (message: Core.CallMessage, unit = "consumer@0"): Stimulus => ({
	name: message._tag,
	event: (s) => {
		const u = HashMap.get(s.units, unit).pipe(Option.getOrThrow)
		return {
			_tag: "CallObserved",
			unit,
			incarnation: u.incarnation,
			observer: u.spawn,
			message,
			now: s.now,
		}
	},
})
const exited = (unit: string): Stimulus => ({
	name: `Exit ${unit}`,
	event: (s) => {
		const u = HashMap.get(s.units, unit).pipe(Option.getOrThrow)
		return {
			_tag: "Exited",
			unit,
			incarnation: u.incarnation,
			observer: u.spawn,
			cleanup: { _tag: "Unknown" },
			cause: Cause.empty,
			now: s.now,
		}
	},
})
const conservation = (s: Core.State) => {
	assert.equal(
		HashSet.size(s.activeCalls),
		HashMap.reduce(s.calls, 0, (n, c) => n + (c.credit ? 1 : 0)),
	)
	for (const c of HashMap.values(s.calls))
		if (c.credit) {
			assert.equal(
				HashMap.get(s.units, c.provider).pipe(Option.getOrThrow).evidence,
				"Missing",
			)
			assert.equal(
				HashMap.get(
					s.callRequests,
					`${c.consumerIncarnation.length}:${c.consumerIncarnation}/${c.session.length}:${c.session}/${c.request}`,
				).pipe(Option.getOrThrow),
				c.key,
			)
		}
}
it("enumerates causal result, cancellation, duplicate completion and native exit shuffles through the production reducer (I2, I5, I9)", () => {
	const initial = registered(requested())
	const completion = message(
		{
			_tag: "Complete",
			key: one(initial).key,
			cleanup: { _tag: "Completed" },
			cause: Cause.empty,
		},
		"provider@0",
	)
	const stats = explore(
		initial,
		[
			[
				message({ _tag: "Result", session: "session-a", request: "1" }),
				message({ _tag: "Cancel", session: "session-a", request: "1" }),
			],
			[completion, completion, exited("provider@0")],
			[exited("other@0")],
		],
		(s) => {
			conservation(s)
			assert.equal(HashSet.size(s.activeCalls), 0)
		},
	)
	assert.equal(stats.schedules, 60)
	assert.equal(stats.transitions, stats.states - 1)
	assert.deepEqual(stats, { schedules: 60, states: 189, transitions: 188 })
})
it("explores repeated call evidence to depth three without a second model (I2, I9, I10)", () => {
	const initial = registered(requested())
	const completion = message(
		{
			_tag: "Complete",
			key: one(initial).key,
			cleanup: { _tag: "Completed" },
			cause: Cause.empty,
		},
		"provider@0",
	)
	const alphabet = [
		message({ _tag: "Result", session: "session-a", request: "1" }),
		message({ _tag: "Cancel", session: "session-a", request: "1" }),
		completion,
		exited("provider@0"),
		exited("consumer@0"),
	]
	const stats = reachable(initial, alphabet, 3)
	for (const s of stats.states) conservation(s)
	assert.isTrue(HashSet.size(stats.states) > 1)
	assert.deepEqual(
		{
			states: HashSet.size(stats.states),
			transitions: stats.transitions,
			depth: stats.depth,
			alphabet: alphabet.length,
		},
		{ states: 93, transitions: 135, depth: 3, alphabet: 5 },
	)
})
