/** One bounded cooperative attempt, decided entirely by the production reducer. */
import { Array, Cause, HashMap, HashSet, Number as Num, Option } from "effect"

import * as Bindings from "./bindingCore"
import * as Calls from "./callCore"
import type {
	Cell,
	Command,
	CommandKind,
	MemberOperation,
	ResolvedInput,
	State,
	Timer,
	Unit,
	Working,
} from "./decisionState"
import * as Executions from "./executionState"
import * as Preparation from "./preparationCore"

const empty: Cell = {
	version: 0,
	writer: Option.none(),
	readers: HashSet.empty(),
}
const cell = (s: State, key: string): Cell =>
	Option.getOrElse(HashMap.get(s.cells, key), () => empty)
const save = (s: Working, operation: MemberOperation): Working => ({
	...s,
	memberOperations: HashMap.set(s.memberOperations, operation.id, operation),
})
const update = (
	s: Working,
	id: string,
	f: (s: Working, operation: MemberOperation) => Working,
): Working =>
	Option.match(HashMap.get(s.memberOperations, id), {
		onNone: () => s,
		onSome: (operation) => f(s, operation),
	})
const operationKeys = (operation: MemberOperation): HashSet.HashSet<string> =>
	HashSet.union(
		operation.writes,
		HashSet.fromIterable(HashMap.keys(operation.reads)),
	)
const notify = (s: Working, members: HashSet.HashSet<string>): Working => ({
	...s,
	changed: HashSet.reduce(members, s.changed, (ids, member) =>
		HashSet.union(
			ids,
			Option.getOrElse(HashMap.get(s.observers, member), HashSet.empty<string>),
		),
	),
})
const issue = (
	s: Working,
	id: string,
	kind: CommandKind,
	timer: Option.Option<string> = Option.none(),
	participant?: string,
): Working =>
	update(s, id, (s, operation) =>
		Option.match(HashMap.get(s.units, participant ?? operation.unit), {
			onNone: () => s,
			onSome: (unit) => {
				const focused = Option.flatMap(operation.currentMember, (id) =>
					HashMap.get(unit.members, id),
				)
				const first = Option.orElse(focused, () =>
					Array.head(Array.fromIterable(HashMap.values(unit.members))),
				)
				if (Option.isNone(first)) return s
				const subjects =
					kind === "ServeMembers"
						? Option.getOrElse(
								Array.get(
									Executions.waves(unit, operation.members),
									operation.serveWave,
								),
								HashSet.empty<string>,
							)
						: participant === undefined || participant === operation.unit
							? operation.members
							: HashSet.fromIterable(
									Array.flatMap(
										Array.fromIterable(
											HashSet.reduce(
												operation.members,
												HashSet.empty<string>(),
												(ids, member) =>
													HashSet.union(ids, Bindings.outgoing(s, member)),
											),
										),
										(id) =>
											Option.toArray(
												Option.flatMap(
													HashMap.get(s.bindings, id),
													(binding) =>
														HashMap.has(unit.members, binding.consumer)
															? Option.some(binding.consumer)
															: Option.none(),
												),
											),
									),
								)
				const command: Command = {
					id: `${id}/${operation.nextCommand}`,
					change: id,
					kind,
					unit: unit.id,
					participant: participant ?? "",
					timer,
					token: {
						authority: s.authority,
						change: id,
						unit: unit.id,
						incarnation: unit.incarnation,
						members: Executions.tokens(
							HashMap.filter(unit.members, (_, id) =>
								HashSet.has(subjects, id),
							),
						),
						view: 1,
					},
					members: Executions.grants(unit.members),
					...(kind === "ServeMembers" ||
					kind === "Install" ||
					kind === "Activate"
						? { view: Bindings.memberView(s, operation) }
						: {}),
					subjects,
					placement: unit.placement,
					target: first.value.target,
					resolutions: operation.resolutions,
					descriptions: HashMap.empty(),
					policies: HashMap.fromIterable(
						Array.map(Array.fromIterable(operation.members), (member) => [
							member,
							Preparation.policy(s, member),
						]),
					),
					policy: Preparation.policy(s, first.value.instance),
					...Option.match(
						HashMap.get(operation.resolutions, first.value.instance),
						{ onNone: () => ({}), onSome: (resolution) => ({ resolution }) },
					),
					dispatched: true,
					status: Option.none(),
					disposition: "Pending",
					report: Option.none(),
				}
				const next = {
					...operation,
					nextCommand: operation.nextCommand + 1,
					commandIds: HashSet.add(operation.commandIds, command.id),
				}
				return {
					...save(s, next),
					commands: HashMap.set(s.commands, command.id, command),
					emitted: Array.append(s.emitted, command),
				}
			},
		}),
	)
const disarm = (s: Working, operation: MemberOperation): Working =>
	HashSet.reduce(operation.timerIds, s, (s, id) =>
		Option.match(HashMap.get(s.timers, id), {
			onNone: () => s,
			onSome: (timer) =>
				timer.active
					? issue(
							{
								...s,
								timers: HashMap.set(s.timers, id, { ...timer, active: false }),
							},
							operation.id,
							"CancelTimer",
							Option.some(id),
						)
					: s,
		}),
	)
const arm = (
	s: Working,
	id: string,
	duration: number,
	evidence = false,
): Working =>
	update(s, id, (s, operation) => {
		const previous = disarm(s, operation)
		const key = `${id}/timer-${HashSet.size(operation.timerIds) + 1}`
		const timer: Timer = {
			id: key,
			change: id,
			generation: 1,
			purpose: evidence ? "Evidence" : "Operation",
			cause: Cause.empty,
			active: true,
			deadline: Num.min(
				s.now + duration,
				operation.deadline -
					(evidence
						? 0
						: Option.getOrElse(
								Option.map(
									HashMap.get(s.units, operation.unit),
									(u) => u.memberBudget.terminate,
								),
								() => 0,
							)),
			),
			command: Option.none(),
		}
		return update(previous, id, (s, latest) =>
			issue(
				{
					...save(s, {
						...latest,
						timerIds: HashSet.add(latest.timerIds, key),
					}),
					timers: HashMap.set(s.timers, key, timer),
				},
				id,
				"ArmTimer",
				Option.some(key),
			),
		)
	})
const release = (s: Working, operation: MemberOperation): Working => ({
	...disarm(s, operation),
	cells: HashSet.reduce(operationKeys(operation), s.cells, (index, key) =>
		HashMap.modify(index, key, (cell) => ({
			...cell,
			writer: Option.contains(cell.writer, operation.id)
				? Option.none()
				: cell.writer,
			readers: HashSet.remove(cell.readers, operation.id),
		})),
	),
})
const finish = (
	s: Working,
	operation: MemberOperation,
	successful: boolean,
): Working =>
	release(
		save(
			successful
				? s
				: {
						...s,
						units: HashMap.modify(s.units, operation.unit, (unit) => ({
							...unit,
							members: HashSet.reduce(
								operation.members,
								unit.members,
								(members, id) =>
									HashMap.modify(members, id, (member) => ({
										...member,
										phase: "Failed",
										cause: Cause.combine(member.cause, operation.cause),
									})),
							),
						})),
					},
			{ ...operation, phase: successful ? "Completed" : "Failed" },
		),
		operation,
	)
const nextResolution = (s: Working, operation: MemberOperation): Working => {
	const member = Array.findFirst(
		operation.members,
		(member) => !HashSet.has(operation.resolved, member),
	)
	if (Option.isNone(member)) return grant(s, operation)
	const next: MemberOperation = {
		...operation,
		phase: "Resolving",
		currentMember: member,
	}
	const unit = HashMap.get(s.units, operation.unit)
	return arm(
		issue(save(s, next), operation.id, "Resolve"),
		operation.id,
		Option.getOrElse(
			Option.map(unit, (unit) => unit.memberBudget.startup),
			() => 0,
		),
	)
}
const install = (s: Working, operation: MemberOperation): Working => {
	const participants = HashSet.reduce(
		Bindings.memberBindings(s, operation.members),
		HashSet.make(operation.unit),
		(units, id) =>
			Option.match(HashMap.get(s.bindings, id), {
				onNone: () => units,
				onSome: (binding) =>
					Option.match(Executions.current(s, binding.consumer), {
						onNone: () => units,
						onSome: ({ unit }) =>
							unit.evidence === "Missing" ? HashSet.add(units, unit.id) : units,
					}),
			}),
	)
	const next: MemberOperation = {
		...operation,
		phase: "Installing",
		participants,
		installed: HashSet.empty(),
	}
	const staged = HashSet.reduce(participants, save(s, next), (s, unit) =>
		issue(s, operation.id, "Install", Option.none(), unit),
	)
	return arm(
		staged,
		operation.id,
		Option.getOrElse(
			Option.map(
				HashMap.get(s.units, operation.unit),
				(unit) => unit.memberBudget.startup,
			),
			() => 0,
		),
	)
}
const activate = (s: Working, operation: MemberOperation): Working => {
	if (
		!HashMap.every(
			operation.reads,
			(version, key) => cell(s, key).version === version,
		)
	)
		return failed(
			s,
			operation.id,
			Cause.fail("Cooperative execution premises changed before publication"),
		)
	const routes = Array.reduce(
		Bindings.memberView(s, operation).routes,
		s.routes,
		(routes, route) => HashMap.set(routes, route.id, route),
	)
	const next: MemberOperation = {
		...operation,
		phase: "Activating",
		activated: HashSet.empty(),
	}
	const committed: Working = {
		...save(s, next),
		routes,
		cells: HashSet.reduce(operation.writes, s.cells, (cells, key) =>
			HashSet.has(operation.members, key)
				? cells
				: HashMap.modify(cells, key, (cell) => ({
						...cell,
						version: cell.version + 1,
					})),
		),
	}
	return HashSet.reduce(operation.participants, committed, (s, unit) =>
		issue(s, operation.id, "Activate", Option.none(), unit),
	)
}
const grant = (s: Working, operation: MemberOperation): Working =>
	Option.match(HashMap.get(s.units, operation.unit), {
		onNone: () => finish(s, operation, false),
		onSome: (unit) => {
			if (
				!HashSet.every(operation.members, (id) =>
					Option.exists(
						HashMap.get(unit.members, id),
						(member) =>
							Executions.authorized(s, id, member.target) &&
							Array.every(
								member.dependencies,
								(dependency) =>
									dependency.optional ||
									Option.exists(
										dependency.provider,
										(provider) =>
											HashSet.has(operation.members, provider) ||
											Executions.healthy(s, provider),
									),
							),
					),
				) ||
				!HashMap.every(
					operation.reads,
					(version, key) => version === cell(s, key).version,
				)
			)
				return finish(
					s,
					{
						...operation,
						cause: Cause.combine(
							operation.cause,
							Cause.fail("Current authorization denies a cooperative attempt"),
						),
					},
					false,
				)
			const changed = HashSet.reduce(operation.members, unit, (unit, id) =>
				Option.match(HashMap.get(unit.members, id), {
					onNone: () => unit,
					onSome: (old) => {
						const term =
							Option.getOrElse(
								Option.map(HashMap.get(s.instances, id), (i) => i.term),
								() => old.term,
							) + 1
						return {
							...unit,
							memberHistory: HashMap.set(unit.memberHistory, id, old),
							members: HashMap.set(unit.members, id, {
								...old,
								term,
								generation: term,
								phase: "Preparing",
								cause: Cause.empty,
								cleanup: { _tag: "Unknown" },
							}),
						}
					},
				}),
			)
			const next: MemberOperation = {
				...operation,
				phase: "Starting",
				reads: HashMap.map(operation.reads, (version, key) =>
					HashSet.has(operation.members, key) ? version + 1 : version,
				),
				currentMember: Option.none(),
			}
			const granted: Working = {
				...save(s, next),
				units: HashMap.set(s.units, unit.id, changed),
				instances: HashSet.reduce(operation.members, s.instances, (index, id) =>
					HashMap.modify(index, id, (instance) => ({
						...instance,
						term: Option.getOrElse(
							Option.map(
								HashMap.get(changed.members, id),
								(member) => member.term,
							),
							() => instance.term,
						),
					})),
				),
				cells: HashSet.reduce(operation.members, s.cells, (index, id) =>
					HashMap.modify(index, id, (cell) => ({
						...cell,
						version: cell.version + 1,
					})),
				),
			}
			return arm(
				issue(
					notify(granted, operation.members),
					operation.id,
					"RestartMembers",
				),
				operation.id,
				unit.memberBudget.startup,
			)
		},
	})
/** `retry` false stops the failed members without starting them again. */
export const start = (
	s: Working,
	unit: Unit,
	affected: HashSet.HashSet<string>,
	cause: Cause.Cause<unknown>,
	retry: boolean,
): Working => {
	const id = `member-operation-${s.nextMemberOperation}`
	const writes = HashSet.reduce(affected, affected, (keys, member) =>
		HashSet.union(
			keys,
			HashSet.union(Bindings.incoming(s, member), Bindings.outgoing(s, member)),
		),
	)
	const dependencies = HashSet.reduce(
		affected,
		HashSet.empty<string>(),
		(keys, id) =>
			Option.match(HashMap.get(unit.members, id), {
				onNone: () => keys,
				onSome: (member) =>
					Array.reduce(member.dependencies, keys, (keys, dependency) =>
						HashSet.union(
							HashSet.union(keys, dependency.slots),
							HashSet.fromIterable(Option.toArray(dependency.provider)),
						),
					),
			}),
	)
	const reads = HashMap.fromIterable(
		Array.map(
			Array.fromIterable(
				HashSet.union(
					HashSet.union(writes, dependencies),
					HashSet.fromIterable(
						Array.map(
							Array.fromIterable(affected),
							(member) => `authorization:${member}`,
						),
					),
				),
			),
			(key) => [key, cell(s, key).version],
		),
	)
	if (
		HashMap.some(
			reads,
			(_, key) =>
				Option.isSome(cell(s, key).writer) ||
				(HashSet.has(writes, key) && HashSet.size(cell(s, key).readers) > 0),
		)
	)
		return s
	const operation: MemberOperation = {
		activated: HashSet.empty(),
		serveWave: 0,
		stoppedAck: false,
		id,
		unit: unit.id,
		incarnation: unit.incarnation,
		members: affected,
		phase: "Stopping",
		retry,
		currentMember: Option.none(),
		resolutions: HashMap.empty(),
		resolved: HashSet.empty(),
		reads,
		writes,
		participants: HashSet.empty(),
		installed: HashSet.empty(),
		deadline: s.now + unit.memberBudget.total,
		cause,
		nextCommand: 1,
		commandIds: HashSet.empty(),
		timerIds: HashSet.empty(),
	}
	const locked: Working = {
		...save(s, operation),
		memberOperationsByUnit: HashMap.set(
			s.memberOperationsByUnit,
			unit.id,
			HashSet.add(
				Option.getOrElse(
					HashMap.get(s.memberOperationsByUnit, unit.id),
					HashSet.empty<string>,
				),
				id,
			),
		),
		nextMemberOperation: s.nextMemberOperation + 1,
		cells: HashMap.reduce(reads, s.cells, (index, _, key) => {
			const current = cell(s, key)
			return HashMap.set(
				index,
				key,
				HashSet.has(writes, key)
					? { ...current, writer: Option.some(id) }
					: { ...current, readers: HashSet.add(current.readers, id) },
			)
		}),
	}
	return arm(issue(locked, id, "StopMembers"), id, unit.memberBudget.stop)
}
export const stopped = (s: Working, unit: Unit): Working =>
	HashSet.reduce(
		Option.getOrElse(
			HashMap.get(s.memberOperationsByUnit, unit.id),
			HashSet.empty<string>,
		),
		s,
		(s, id) =>
			update(s, id, (s, operation) =>
				operation.phase === "Stopping" &&
				!Calls.memberOutstanding(s, unit.id, operation.members) &&
				operation.stoppedAck &&
				operation.incarnation === unit.incarnation &&
				HashSet.every(operation.members, (id) =>
					Option.exists(
						HashMap.get(unit.members, id),
						(member) =>
							member.phase === "Stopped" || member.phase === "NotStarted",
					),
				)
					? operation.retry
						? nextResolution(s, operation)
						: finish(s, operation, false)
					: s,
			),
	)
export const reported = (s: Working, command: Command): Working =>
	update(s, command.change, (s, operation) => {
		if (
			operation.phase === "Completed" ||
			operation.phase === "Failed" ||
			operation.phase === "Unconfirmed"
		)
			return s
		if (Option.exists(command.report, (report) => report._tag === "Failed")) {
			const failure: MemberOperation = {
				...operation,
				retry: false,
				cause: Cause.combine(
					operation.cause,
					Option.getOrElse(
						Option.map(command.report, (report) =>
							report._tag === "Failed" ? report.cause : Cause.empty,
						),
						() => Cause.empty,
					),
				),
			}
			const observed = save(s, {
				...failure,
				stoppedAck: command.kind === "StopMembers" || failure.stoppedAck,
			})
			return command.kind === "StopMembers"
				? Option.match(HashMap.get(observed.units, operation.unit), {
						onNone: () => finish(observed, failure, false),
						onSome: (unit) => stopped(observed, unit),
					})
				: failed(observed, operation.id, Cause.empty)
		}
		switch (command.kind) {
			case "StopMembers": {
				const acknowledged = save(s, { ...operation, stoppedAck: true })
				return Option.match(HashMap.get(acknowledged.units, operation.unit), {
					onNone: () => finish(acknowledged, operation, false),
					onSome: (unit) => stopped(acknowledged, unit),
				})
			}
			case "Resolve": {
				if (
					operation.phase !== "Resolving" ||
					Option.isNone(operation.currentMember)
				)
					return s
				const member = operation.currentMember.value
				const resolution = Option.flatMap(command.report, (report) =>
					report._tag === "Resolved"
						? Option.some(report.value)
						: Option.none<ResolvedInput>(),
				)
				const next = {
					...operation,
					resolved: HashSet.add(operation.resolved, member),
					resolutions: Option.match(resolution, {
						onNone: () => operation.resolutions,
						onSome: (value) =>
							HashMap.set(operation.resolutions, member, value),
					}),
				}
				return nextResolution(save(s, next), next)
			}
			case "RestartMembers": {
				const report = Option.filter(
					command.report,
					(report) => report._tag === "Started",
				)
				const next = {
					...operation,
					phase: "Serving",
					serveWave: 0,
				} satisfies MemberOperation
				const loaded = {
					...save(s, next),
					units: HashMap.modify(s.units, operation.unit, (unit) => ({
						...unit,
						members: HashMap.map(unit.members, (member) => ({
							...member,
							endpoint: HashSet.has(operation.members, member.instance)
								? Option.flatMap(report, (report) =>
										HashMap.get(report.endpoints, member.instance),
									)
								: member.endpoint,
						})),
					})),
				}
				return issue(loaded, operation.id, "ServeMembers")
			}
			case "ServeMembers": {
				const next = { ...operation, serveWave: operation.serveWave + 1 }
				const unit = HashMap.get(s.units, operation.unit)
				if (Option.isNone(unit)) return finish(s, operation, false)
				return issue(
					save(s, next),
					operation.id,
					next.serveWave <
						Executions.waves(unit.value, operation.members).length
						? "ServeMembers"
						: "ReadyMembers",
				)
			}
			case "ReadyMembers": {
				if (operation.phase !== "Serving") return s
				const unit = HashMap.get(s.units, operation.unit)
				if (Option.isNone(unit)) return finish(s, operation, false)
				const ready = Executions.update(unit.value, operation.members, "Ready")
				return install(
					notify(
						{ ...s, units: HashMap.set(s.units, ready.id, ready) },
						operation.members,
					),
					operation,
				)
			}
			case "Install": {
				if (
					operation.phase !== "Installing" ||
					!HashSet.has(operation.participants, command.unit)
				)
					return s
				const next = {
					...operation,
					installed: HashSet.add(operation.installed, command.unit),
				}
				return HashSet.size(next.installed) === HashSet.size(next.participants)
					? activate(save(s, next), next)
					: save(s, next)
			}
			case "Activate": {
				if (
					operation.phase !== "Activating" ||
					!HashSet.has(operation.participants, command.unit)
				)
					return s
				const next = {
					...operation,
					activated: HashSet.add(operation.activated, command.unit),
				}
				const resumed = HashSet.reduce(
					operation.members,
					save(s, next),
					Calls.resume,
				)
				return HashSet.size(next.activated) === HashSet.size(next.participants)
					? finish(resumed, next, true)
					: resumed
			}
			default:
				return s
		}
	})
export const timeout = (s: Working, id: string): Working =>
	update(s, id, (s, operation) =>
		Option.match(HashMap.get(s.units, operation.unit), {
			onNone: () => finish(s, operation, false),
			onSome: (unit) => {
				if (unit.evidence !== "Missing") return finish(s, operation, false)
				const failed: MemberOperation = {
					...operation,
					phase: "Unconfirmed",
					retry: false,
					cause: Cause.combine(
						operation.cause,
						Cause.fail(
							"Cooperative member settlement required whole-unit termination",
						),
					),
				}
				const stopping = Executions.update(
					unit,
					HashSet.fromIterable(HashMap.keys(unit.members)),
					"Stopping",
				)
				return arm(
					issue(
						notify(
							{
								...save(s, failed),
								units: HashMap.set(s.units, unit.id, {
									...stopping,
									cause: Cause.combine(unit.cause, failed.cause),
									phase: "Terminating",
								}),
							},
							HashSet.fromIterable(HashMap.keys(unit.members)),
						),
						id,
						"Terminate",
					),
					id,
					unit.memberBudget.terminate,
					true,
				)
			},
		}),
	)
export const failed = (
	s: Working,
	id: string,
	cause: Cause.Cause<unknown>,
): Working =>
	update(s, id, (s, operation) => {
		const next = { ...operation, cause: Cause.combine(operation.cause, cause) }
		if (operation.phase === "Stopping") return save(s, next)
		if (
			operation.phase === "Completed" ||
			operation.phase === "Failed" ||
			operation.phase === "Unconfirmed"
		)
			return save(s, next)
		const stopping: MemberOperation = {
			...next,
			phase: "Stopping",
			retry: false,
			stoppedAck: false,
		}
		const discarded =
			operation.phase === "Installing"
				? HashSet.reduce(operation.participants, save(s, stopping), (s, unit) =>
						issue(s, id, "Discard", Option.none(), unit),
					)
				: save(s, stopping)
		return arm(
			issue(discarded, id, "StopMembers"),
			id,
			Option.getOrElse(
				Option.map(
					HashMap.get(s.units, operation.unit),
					(unit) => unit.memberBudget.stop,
				),
				() => 0,
			),
		)
	})
export const timer = (s: Working, timer: Timer): Working => {
	const fired = {
		...s,
		timers: HashMap.set(s.timers, timer.id, { ...timer, active: false }),
	}
	return timer.purpose === "Evidence" ? fired : timeout(fired, timer.change)
}
export const timerEnded = (
	s: Working,
	event: {
		readonly timer: string
		readonly generation: number
		readonly cause: Cause.Cause<unknown>
	},
): Working =>
	Option.match(HashMap.get(s.timers, event.timer), {
		onNone: () => s,
		onSome: (timer) =>
			!timer.active || timer.generation !== event.generation
				? s
				: update(
						{
							...s,
							timers: HashMap.set(s.timers, timer.id, {
								...timer,
								active: false,
								cause: Cause.combine(timer.cause, event.cause),
							}),
						},
						timer.change,
						(s, operation) =>
							timeout(
								save(s, {
									...operation,
									cause: Cause.combine(operation.cause, event.cause),
								}),
								operation.id,
							),
					),
	})
export const ended = (s: Working, unit: Unit): Working =>
	HashSet.reduce(
		Option.getOrElse(
			HashMap.get(s.memberOperationsByUnit, unit.id),
			HashSet.empty<string>,
		),
		s,
		(s, id) =>
			update(s, id, (s, operation) =>
				operation.unit === unit.id &&
				operation.incarnation === unit.incarnation &&
				operation.phase !== "Completed" &&
				operation.phase !== "Failed"
					? finish(s, operation, false)
					: s,
			),
	)
