import { Array as Arr, Cause, HashMap, HashSet, Option } from "effect"

import * as Core from "../../src/internal/decisionCore.ts"

export const target = (identity: string): Core.Target => ({
	identity,
	placement: "Worker",
	overlap: true,
})
export const initial = (count = 2, maxUnits = count + 2): Core.State =>
	Core.make({
		authority: "test",
		maxUnits,
		instances: Arr.makeBy(count, (i) => ({
			id: `instance-${i}`,
			target: target("original"),
		})),
	})
export const request = (
	s: Core.State,
	instance = "instance-0",
	strategy: Core.Strategy = "Overlap",
): Core.Request => ({
	instance,
	target: target("next"),
	strategy,
	reads: HashMap.make([instance, Core.cell(s, instance).version]),
	writes: HashSet.make(instance),
	leases: HashSet.empty(),
	participants: HashSet.empty(),
	budget: {
		total: 1000,
		startup: 50,
		probe: 50,
		drain: 50,
		stop: 50,
		terminate: 50,
	},
	trial: 10,
})
export const submit = (s: Core.State, r = request(s)): Core.State =>
	Core.reduce(s, { _tag: "Submit", request: r, now: s.now }).state
export const pending = (
	s: Core.State,
	change: string,
	kind: Core.CommandKind,
): Core.Command =>
	Option.getOrThrow(
		Arr.findFirst(
			HashMap.values(s.commands),
			(c) =>
				c.change === change &&
				c.kind === kind &&
				c.disposition === "Pending" &&
				Option.exists(
					HashMap.get(s.changes, change),
					(owner) => owner.view === c.token.view,
				),
		),
	)
export const report = (
	s: Core.State,
	c: Core.Command,
	result?: Core.Report,
): Core.State =>
	Core.reduce(s, {
		_tag: "Reported",
		command: c.id,
		token: c.token,
		result:
			result ??
			(c.kind === "Start" && c.description !== undefined
				? { _tag: "Started", value: c.description }
				: c.kind === "Resolve" && c.resolution !== undefined
					? { _tag: "Resolved", value: c.resolution }
					: { _tag: "Succeeded" }),
		now: s.now,
	}).state
export const succeed = (
	s: Core.State,
	id: string,
	kind: Core.CommandKind,
): Core.State => report(s, pending(s, id, kind))
export const exit = (
	s: Core.State,
	unit: string,
	cleanup: Core.Cleanup = { _tag: "Unknown" },
): Core.State => {
	const u = Option.getOrThrow(HashMap.get(s.units, unit))
	return Core.reduce(s, {
		_tag: "Exited",
		unit,
		incarnation: u.incarnation,
		observer: u.spawn,
		cleanup,
		cause: Cause.empty,
		now: s.now,
	}).state
}
export const fire = (
	s: Core.State,
	id: string,
	purpose: Core.TimerPurpose,
): Core.State => {
	const t = Option.getOrThrow(
		Arr.findFirst(
			HashMap.values(s.timers),
			(t) => t.change === id && t.purpose === purpose && t.active,
		),
	)
	return Core.reduce(s, {
		_tag: "TimerFired",
		timer: t.id,
		generation: t.generation,
		now: t.deadline,
	}).state
}
export const started = (s: Core.State, id: string): Core.State =>
	Arr.reduce(
		[
			"Resolve",
			"Spawn",
			"Start",
			"Serve",
			"Ready",
			"Probe",
		] satisfies ReadonlyArray<Core.CommandKind>,
		s,
		(s, kind) => succeed(s, id, kind),
	)
export const installed = (s: Core.State, id: string): Core.State =>
	succeed(started(s, id), id, "Install")
export const accept = (s: Core.State, id: string): Core.State => {
	const trial = fire(installed(s, id), id, "Trial")
	const stop = Arr.findFirst(
		HashMap.values(trial.commands),
		(c) => c.change === id && c.kind === "Stop" && c.disposition === "Pending",
	)
	return Option.match(stop, {
		onNone: () => trial,
		onSome: (c) => exit(succeed(trial, id, "Stop"), c.unit),
	})
}
export const status = (s: Core.State, id = "change-1"): Core.Status =>
	Option.getOrThrow(Core.get(s, id))
export const conclusion = (s: Core.State, id = "change-1"): Core.Conclusion =>
	Option.getOrThrow(status(s, id).conclusion)

export const reportEvent = (
	s: Core.State,
	id: string,
	kind: Core.CommandKind,
): Core.Event => {
	const command = pending(s, id, kind)
	return {
		_tag: "Reported",
		command: command.id,
		token: command.token,
		result: { _tag: "Succeeded" },
		now: s.now,
	}
}
export const exitEvent = (s: Core.State, id: string): Core.Event => {
	const unit = Option.getOrThrow(HashMap.get(s.units, id))
	return {
		_tag: "Exited",
		unit: id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		cleanup: { _tag: "Unknown" },
		cause: Cause.empty,
		now: s.now,
	}
}
export const timerEvent = (
	s: Core.State,
	id: string,
	purpose: Core.TimerPurpose,
): Core.Event => {
	const timer = Option.getOrThrow(
		Arr.findFirst(
			HashMap.values(s.timers),
			(timer) =>
				timer.change === id && timer.purpose === purpose && timer.active,
		),
	)
	return {
		_tag: "TimerFired",
		timer: timer.id,
		generation: timer.generation,
		now: timer.deadline,
	}
}
