import { Array, Cause, HashMap, Option } from "effect"
import { assert } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore.ts"

export const target = (identity = "next"): Core.Target => ({
	identity,
	placement: "Worker",
	overlap: false,
	deployment: {
		artifact: {
			directory: "/artifacts/" + identity,
			identity: {
				version: 1,
				algorithm: "sha256",
				digest: identity,
				entry: "plugin.js",
			},
		},
		contract: "contract.js",
		input: { value: 1 },
	},
})
export const initial = (maxUnits = 3) =>
	Core.empty({
		authority: "preparation-test",
		maxUnits,
		instances: [{ id: "a", target: target("old") }],
	})
export const input = (key?: string): Core.Input => ({
	instance: "a",
	target: target(),
	strategy: "Restart",
	budget: {
		total: 3000,
		startup: 500,
		probe: 100,
		drain: 100,
		stop: 100,
		terminate: 100,
	},
	...(key === undefined ? {} : { key }),
})
export const prepare = (
	state = initial(),
	request = input(),
	inspect = false,
) =>
	Core.reduce(state, {
		_tag: inspect ? "InspectRequested" : "Requested",
		request,
		now: state.now,
	})
export const id = (transition: Core.Transition): string => {
	assert.equal(transition.reply._tag, "Preparing")
	return transition.reply._tag === "Preparing"
		? transition.reply.preparation
		: "Unexpected reply"
}
export const command = (
	s: Core.State,
	preparation: string,
	kind: Core.CommandKind,
): Core.Command =>
	Option.getOrThrow(
		Array.findFirst(
			HashMap.values(s.commands),
			(c) =>
				c.change === preparation &&
				c.kind === kind &&
				c.disposition === "Pending",
		),
	)
export const report = (
	s: Core.State,
	c: Core.Command,
	result: Core.Report,
	now = s.now,
) =>
	Core.reduce(s, {
		_tag: "Reported",
		command: c.id,
		token: c.token,
		result,
		now,
	}).state
export const resolved: Core.ResolvedInput = {
	input: { value: 1 },
	identity: "config-1",
	environment: "test-runtime",
}
export const description = (t = target()): Core.Description => ({
	artifact: t.deployment?.artifact.identity.digest ?? "Missing artifact",
	configuration: resolved.identity,
	environment: resolved.environment,
	protocol: 1,
	overlap: true,
	members: 1,
	requires: [],
	provides: [],
	probes: [],
})
export const spawned = (s: Core.State, preparation: string) =>
	report(
		report(s, command(s, preparation, "Resolve"), {
			_tag: "Resolved",
			value: resolved,
		}),
		command(
			report(s, command(s, preparation, "Resolve"), {
				_tag: "Resolved",
				value: resolved,
			}),
			preparation,
			"Spawn",
		),
		{ _tag: "Succeeded" },
	)
export const described = (s: Core.State, p: string, d = description()) =>
	report(spawned(s, p), command(spawned(s, p), p, "Describe"), {
		_tag: "Described",
		value: d,
	})
export const exit = (s: Core.State, p: string, now = s.now) => {
	const prep = Option.getOrThrow(HashMap.get(s.preparations, p))
	const unit = Option.getOrThrow(HashMap.get(s.units, prep.unit))
	return Core.reduce(s, {
		_tag: "Exited",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		cleanup: { _tag: "Completed" },
		cause: Cause.empty,
		now,
	})
}
export const timer = (s: Core.State, p: string, purpose: Core.TimerPurpose) =>
	Option.getOrThrow(
		Array.findFirst(
			HashMap.values(s.timers),
			(t) => t.change === p && t.active && t.purpose === purpose,
		),
	)
export const fire = (s: Core.State, p: string, purpose: Core.TimerPurpose) => {
	const t = timer(s, p, purpose)
	return Core.reduce(s, {
		_tag: "TimerFired",
		timer: t.id,
		generation: t.generation,
		now: t.deadline,
	}).state
}
