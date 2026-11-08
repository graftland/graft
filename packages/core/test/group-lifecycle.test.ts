import { Array, Cause, Equal, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import * as Executions from "../src/internal/executionState"
import { exit, fire, pending, report, request } from "./change-model/scenarios"
import { declaredMembers, rootRealms } from "./member-fact"

const declaration = (
	id: string,
	patch: Partial<Core.MemberDeclaration> = {},
): Core.MemberDeclaration => ({
	...Option.getOrThrow(
		Array.head(
			declaredMembers([
				{ id, target: { identity: id, placement: "Worker", overlap: true } },
			]),
		),
	),
	placement: Option.none(),
	...patch,
})
const old = [
	declaration("a", { localProvides: ["ab"] }),
	declaration("b", { localRequires: [{ key: "ab", optional: false }] }),
	declaration("c", { localProvides: ["cd"] }),
	declaration("d", { localRequires: [{ key: "cd", optional: false }] }),
]
const desired = [
	declaration("a"),
	declaration("b", { localProvides: ["bc"] }),
	declaration("c", { localRequires: [{ key: "bc", optional: false }] }),
	declaration("d"),
]
const initial = () =>
	Core.make({
		authority: "group-execution",
		maxUnits: 6,
		declarations: old,
		realms: rootRealms,
	})
const submit = (state = initial(), strategy: Core.Strategy = "Restart") =>
	Core.reduce(state, {
		_tag: "Submit",
		now: state.now,
		request: {
			...request(state, "a", strategy),
			proposal: {
				members: desired,
				explicit: HashSet.make("a"),
				removed: HashSet.empty(),
				realms: [],
			},
		},
	})
const selected = (state: Core.State) =>
	Option.getOrThrow(HashMap.get(state.changes, "change-1"))
const status = (state: Core.State) =>
	Option.getOrThrow(Core.get(state, "change-1"))
const oldUnits = (state: Core.State) =>
	HashSet.fromIterable(
		Array.flatMap(old, (member) =>
			Option.toArray(
				Option.flatMap(
					HashMap.get(state.instances, member.instance),
					(instance) => instance.current,
				),
			),
		),
	)
const runtimeKinds = HashSet.fromIterable<Core.CommandKind>([
	"Resolve",
	"Spawn",
	"Start",
	"Serve",
	"Ready",
	"Probe",
	"Install",
	"Activate",
	"Stop",
	"Terminate",
])
/** This fixture only returns external evidence for production-issued commands. */
const complete = (
	state: Core.State,
	remaining = 100,
	stopAt?: Core.Phase,
): Core.State => {
	assert.isAbove(remaining, 0, "The group command protocol failed to settle")
	if (Option.isSome(status(state).conclusion) || status(state).phase === stopAt)
		return state
	const command = Array.findFirst(
		HashMap.values(state.commands),
		(command) =>
			command.change === "change-1" &&
			command.disposition === "Pending" &&
			command.token.view === selected(state).view &&
			HashSet.has(runtimeKinds, command.kind),
	)
	if (Option.isSome(command)) {
		const next = report(state, command.value)
		return complete(
			command.value.kind === "Stop" || command.value.kind === "Terminate"
				? exit(next, command.value.unit, { _tag: "Completed" })
				: next,
			remaining - 1,
			stopAt,
		)
	}
	const trial = Array.findFirst(
		HashMap.values(state.timers),
		(timer) =>
			timer.change === "change-1" && timer.purpose === "Trial" && timer.active,
	)
	assert.isTrue(
		Option.isSome(trial),
		`No executable command or trial timer in ${status(state).phase}: ${Array.join(
			Array.map(
				Array.fromIterable(HashMap.values(state.commands)),
				(command) => `${command.kind}:${command.disposition}`,
			),
			", ",
		)}`,
	)
	return complete(fire(state, "change-1", "Trial"), remaining - 1, stopAt)
}

it("stops each distinct old group once and waits for all shared exit evidence before starting any replacement (I5, I6, I7, F5, F6)", () => {
	const before = initial()
	const result = submit(before)
	const required = selected(result.state).requiredExits
	assert.equal(HashSet.size(required), 2)
	assert.sameMembers(
		Array.fromIterable(required),
		Array.fromIterable(oldUnits(before)),
	)
	assert.equal(
		Array.filter(result.commands, (command) => command.kind === "Stop").length,
		2,
	)
	const first = Option.getOrThrow(Array.head(Array.fromIterable(required)))
	const partial = exit(result.state, first, { _tag: "Completed" })
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(partial.commands)),
			(command) => command.kind === "Spawn",
		),
	)
	const other = Option.getOrThrow(
		Array.findFirst(required, (id) => id !== first),
	)
	const ready = exit(partial, other, { _tag: "Completed" })
	assert.isTrue(
		Array.some(
			Array.fromIterable(HashMap.values(ready.commands)),
			(command) => command.kind === "Resolve",
		),
	)
})

it.each(["Restart", "Overlap"] satisfies ReadonlyArray<Core.Strategy>)(
	"executes the complete three-group %s plan with one Change and exact per-member facts (I4, I5, I6, I7, F4, F5, F6)",
	(strategy) => {
		const result = complete(submit(initial(), strategy).state)
		const observed = status(result)
		assert.equal(Option.getOrThrow(observed.conclusion).outcome, "Accepted")
		assert.equal(HashMap.size(result.changes), 1)
		assert.equal(HashMap.size(observed.members), 4)
		assert.isTrue(
			HashMap.every(
				observed.members,
				(member) => member.healthy && member.matchesTarget,
			),
		)
		const current = HashSet.fromIterable(
			Array.flatMap(Array.fromIterable(observed.members), ([id]) =>
				Option.toArray(
					Option.flatMap(
						HashMap.get(result.instances, id),
						(instance) => instance.current,
					),
				),
			),
		)
		assert.equal(HashSet.size(current), 3)
		assert.equal(Core.capacity(result).used, 3)
		assert.equal(Core.capacity(result).reserved, 0)
		assert.equal(HashSet.size(observed.unconfirmedUnits), 0)
		assert.equal(HashSet.size(observed.leaseHolders), 0)
	},
)

it("settles all members of a shared old unit and frees its claim once, including collateral members (I6, I7, F9, F12)", () => {
	const before = initial()
	const result = submit(before)
	const shared = Option.getOrThrow(
		Option.flatMap(
			HashMap.get(before.instances, "a"),
			(instance) => instance.current,
		),
	)
	const ended = exit(result.state, shared)
	for (const id of ["a", "b"]) assert.isFalse(Executions.healthy(ended, id))
	const unit = Option.getOrThrow(HashMap.get(ended.units, shared))
	assert.equal(unit.evidence, "Exited")
	assert.isTrue(
		Option.isNone(
			Option.getOrThrow(HashMap.get(ended.claims, unit.claim)).unit,
		),
	)
	assert.isTrue(Equal.equals(exit(ended, shared).units, ended.units))
	assert.isTrue(Equal.equals(exit(ended, shared).claims, ended.claims))
})

it("keeps every unconfirmed shared incarnation and all conflicting reservations after a group deadline (I5, I7, F9, F9, F12)", () => {
	const admitted = submit().state
	const timed = fire(
		fire(admitted, "change-1", "Total"),
		"change-1",
		"Evidence",
	)
	const observed = status(timed)
	assert.equal(Option.getOrThrow(observed.conclusion).outcome, "Stuck")
	assert.equal(HashSet.size(observed.unconfirmedUnits), 2)
	for (const id of ["a", "b", "c", "d"])
		assert.isTrue(Option.contains(Core.cell(timed, id).writer, "change-1"))
	const original = observed.conclusion
	const late = Array.reduce(
		Array.fromIterable(observed.unconfirmedUnits),
		timed,
		(state, id) => exit(state, id),
	)
	assert.strictEqual(status(late).conclusion, original)
	assert.equal(HashSet.size(status(late).unconfirmedUnits), 0)
})

it("rejects a stale group acknowledgement after discard without activating a partial view (I6, I7, F4, F6)", () => {
	const first = submit(initial(), "Overlap").state
	const started = complete(first, 100, "Installing")
	const install = pending(started, "change-1", "Install")
	const failed = Core.reduce(started, {
		_tag: "Cancel",
		change: "change-1",
		cause: Cause.fail("Discard the complete group patch"),
		now: started.now,
	}).state
	const late = report(failed, install)
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(late.commands)),
			(command) =>
				command.kind === "Activate" &&
				command.token.view === install.token.view,
		),
	)
	assert.isFalse(selected(late).trialPassed)
})

it.each(["Overlap", "Restart"] satisfies ReadonlyArray<Core.Strategy>)(
	"settles a partial group view rejection under %s without activating staging or losing an unrelated commit (I5, I6, I7, F4, F5, F6, F13)",
	(strategy) => {
		const installing = complete(
			submit(initial(), strategy).state,
			100,
			"Installing",
		)
		const installs = Array.filter(
			Array.fromIterable(HashMap.values(installing.commands)),
			(command) =>
				command.kind === "Install" &&
				command.disposition === "Pending" &&
				command.token.view === selected(installing).view,
		)
		assert.equal(installs.length, 3)
		const first = Option.getOrThrow(Array.head(installs))
		const second = Option.getOrThrow(Array.get(installs, 1))
		const partial = report(installing, first)
		const rejected = report(partial, second, {
			_tag: "Failed",
			creation: "Unknown",
			cause: Cause.fail("Group participant refused its staged patch"),
		})
		assert.isFalse(
			Array.some(
				Array.fromIterable(HashMap.values(rejected.commands)),
				(command) =>
					command.kind === "Activate" &&
					command.token.view === first.token.view,
			),
		)
		const settled = complete(rejected)
		const result = Option.getOrThrow(status(settled).conclusion)
		assert.equal(
			result.outcome,
			strategy === "Overlap" ? "Aborted" : "Recovered",
		)
		assert.equal(HashSet.size(status(settled).unconfirmedUnits), 0)
		assert.equal(HashSet.size(status(settled).leaseHolders), 0)
		assert.include(Cause.pretty(result.cause), "Group participant refused")
	},
)

it("invalidates an owning Change on exact member failure instead of granting a competing cooperative attempt (I6, I7, F20)", () => {
	const before = initial()
	const admitted = submit(before, "Overlap").state
	const unit = Option.getOrThrow(
		Option.flatMap(HashMap.get(before.instances, "a"), (instance) =>
			Option.flatMap(instance.current, (id) => HashMap.get(before.units, id)),
		),
	)
	const grant = Option.getOrThrow(HashMap.get(unit.members, "a"))
	const failed = Core.reduce(admitted, {
		_tag: "MemberFailed",
		unit: unit.id,
		incarnation: unit.incarnation,
		observer: unit.spawn,
		member: "a",
		term: grant.term,
		generation: grant.generation,
		cause: Cause.fail("A member failed during its replacement"),
		now: admitted.now,
	})
	assert.isTrue(selected(failed.state).failure)
	assert.isFalse(
		Array.some(failed.commands, (command) => command.kind === "RestartMembers"),
	)
	assert.isTrue(
		Option.contains(Core.cell(failed.state, "a").writer, "change-1"),
	)
	assert.include(Cause.pretty(status(failed.state).cause), "A member failed")
})

const ordinaryGroup = () =>
	Core.make({
		authority: "ordinary-group",
		maxUnits: 3,
		realms: rootRealms,
		declarations: [
			declaration("p", { colocate: ["ordinary"], localProvides: ["value"] }),
			declaration("q", { localRequires: [{ key: "value", optional: false }] }),
			declaration("p/s", { declaration: "s", parent: Option.some("p") }),
			declaration("r", { colocate: ["ordinary"] }),
		],
	})

it("closes over actual recovered co-residents as well as desired groups when a later Change splits their topology again (I2, I4, I5, I7, F13, F14)", () => {
	const published = complete(submit(initial(), "Restart").state, 100, "Trial")
	const failed = Core.reduce(published, {
		_tag: "Cancel",
		change: "change-1",
		cause: Cause.fail("Recover the complete previous desired topology"),
		now: published.now,
	}).state
	const restored = complete(failed)
	assert.equal(
		Option.getOrThrow(status(restored).conclusion).outcome,
		"Recovered",
	)
	assert.equal(HashMap.size(restored.graph.groups), 3)
	assert.equal(Core.capacity(restored).used, 2)
	const second = Core.reduce(restored, {
		_tag: "Submit",
		request: {
			...request(restored, "a", "Restart"),
			proposal: {
				members: [
					declaration("a", {
						target: { identity: "second", placement: "Worker", overlap: true },
					}),
				],
				explicit: HashSet.make("a"),
				removed: HashSet.empty(),
				realms: [],
			},
		},
		now: restored.now,
	})
	assert.equal(second.reply._tag, "Admitted")
	const change = Option.getOrThrow(
		HashMap.get(second.state.changes, "change-2"),
	)
	assert.sameMembers(Array.fromIterable(change.plan.members), [
		"a",
		"b",
		"c",
		"d",
	])
	assert.equal(change.plan.oldUnitCount, 2)
	assert.equal(HashMap.size(change.plan.recoveryGroups), 3)
	assert.equal(change.plan.peakUnits, 3)
})
const signal = (
	state: Core.State,
	instance: string,
	tag: "MemberFailed" | "MemberStopped",
) => {
	const current = Option.getOrThrow(Executions.current(state, instance))
	const identity = {
		unit: current.unit.id,
		incarnation: current.unit.incarnation,
		observer: current.unit.spawn,
		member: instance,
		term: current.member.term,
		generation: current.member.generation,
		now: state.now,
	}
	return Core.reduce(
		state,
		tag === "MemberFailed"
			? { ...identity, _tag: tag, cause: Cause.fail("Ordinary member failure") }
			: {
					...identity,
					_tag: tag,
					cleanup: { _tag: "Completed" },
					cause: Cause.empty,
				},
	)
}
it("grants one cooperative attempt only after every related scope and its stop command settle, retaining the healthy co-resident (I6, I7, F8, F20)", () => {
	const before = ordinaryGroup()
	const failed = signal(before, "p", "MemberFailed")
	const stop = Option.getOrThrow(
		Array.findFirst(
			failed.commands,
			(command) => command.kind === "StopMembers",
		),
	)
	assert.sameMembers(Array.fromIterable(stop.subjects), ["p", "q", "p/s"])
	assert.equal(HashMap.size(failed.state.changes), 0)
	const stopped = Array.reduce(
		["p", "q", "p/s"],
		failed.state,
		(state, member) => signal(state, member, "MemberStopped").state,
	)
	assert.isFalse(
		Array.some(
			Array.fromIterable(HashMap.values(stopped.commands)),
			(command) => command.kind === "RestartMembers",
		),
	)
	const acknowledged = report(stopped, stop)
	const resolved = Array.reduce([0, 1, 2], acknowledged, (state) => {
		const command = Option.getOrThrow(
			Array.findFirst(
				HashMap.values(state.commands),
				(command) =>
					command.kind === "Resolve" && command.disposition === "Pending",
			),
		)
		return report(state, command, {
			_tag: "Resolved",
			value: { input: {}, identity: "fresh", environment: "test" },
		})
	})
	const restart = Option.getOrThrow(
		Array.findFirst(
			HashMap.values(resolved.commands),
			(command) => command.kind === "RestartMembers",
		),
	)
	for (const id of ["p", "q", "p/s"])
		assert.equal(Option.getOrThrow(HashMap.get(restart.members, id)).term, 1)
	assert.equal(
		Option.getOrThrow(Executions.current(resolved, "r")).member.term,
		0,
	)
	assert.isTrue(Executions.healthy(resolved, "r"))
	const served = (state: Core.State): Core.State => {
		const command = Array.findFirst(
			HashMap.values(state.commands),
			(command) =>
				command.kind === "ServeMembers" && command.disposition === "Pending",
		)
		return Option.isNone(command) ? state : served(report(state, command.value))
	}
	const starting = served(report(resolved, restart))
	const ready = Option.getOrThrow(
		Array.findFirst(
			HashMap.values(starting.commands),
			(command) => command.kind === "ReadyMembers",
		),
	)
	const installing = report(starting, ready)
	const installed = report(
		installing,
		Option.getOrThrow(
			Array.findFirst(
				HashMap.values(installing.commands),
				(command) =>
					command.kind === "Install" && command.disposition === "Pending",
			),
		),
	)
	const active = report(
		installed,
		Option.getOrThrow(
			Array.findFirst(
				HashMap.values(installed.commands),
				(command) =>
					command.kind === "Activate" && command.disposition === "Pending",
			),
		),
	)
	assert.isTrue(Executions.healthy(active, "p"))
	assert.isTrue(Executions.healthy(active, "q"))
	assert.equal(Core.capacity(active).used, 1)
	assert.isTrue(Option.isNone(Core.cell(active, "p").writer))
	assert.equal(HashMap.size(active.changes), 0)
})
