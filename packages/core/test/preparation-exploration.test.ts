import { Cause, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import { explore, type Stimulus } from "./change-model/explore"
import {
	command,
	description,
	id,
	initial,
	input,
	prepare,
	resolved,
} from "./preparation-fixture"

const report = (
	preparation: string,
	kind: Core.CommandKind,
	result: Core.Report,
): Stimulus => ({
	name: kind,
	event: (s) => {
		const c = command(s, preparation, kind)
		return {
			_tag: "Reported",
			command: c.id,
			token: c.token,
			result,
			now: s.now,
		}
	},
})
it("explores every preparation, duplicate and current-policy shuffle through the production reducer (I1, I2, I4, I7, I11)", () => {
	const request = input("inspection")
	const first = prepare(initial(), request)
	const p = id(first)
	const inspection: ReadonlyArray<Stimulus> = [
		report(p, "Resolve", { _tag: "Resolved", value: resolved }),
		report(p, "Spawn", { _tag: "Succeeded" }),
		report(p, "Describe", { _tag: "Described", value: description() }),
		report(p, "Stop", { _tag: "Succeeded" }),
		{
			name: "Native inspection exit",
			event: (s) => {
				const prep = Option.getOrThrow(HashMap.get(s.preparations, p))
				const u = Option.getOrThrow(HashMap.get(s.units, prep.unit))
				return {
					_tag: "Exited",
					unit: u.id,
					incarnation: u.incarnation,
					observer: u.spawn,
					cleanup: { _tag: "Completed" },
					cause: Cause.empty,
					now: s.now,
				}
			},
		},
	]
	const stats = explore(
		first.state,
		[
			inspection,
			[
				{
					name: "Duplicate",
					event: (s) => ({ _tag: "Requested", request, now: s.now }),
				},
			],
			[
				{
					name: "Revoke",
					event: (s) => ({
						_tag: "PolicyChanged",
						instance: "a",
						allowed: [],
						values: {},
						now: s.now,
					}),
				},
			],
		],
		(s) => {
			const fact = Option.getOrThrow(Core.getPreparation(s, p))
			assert.equal(fact.exitEvidence, "Exited")
			assert.equal(HashSet.size(fact.unconfirmedUnits), 0)
			assert.equal(HashMap.size(s.preparations), 1)
			assert.isAtMost(HashMap.size(s.changes), 1)
		},
	)
	assert.deepEqual(stats, { schedules: 42, states: 160, transitions: 159 })
})
