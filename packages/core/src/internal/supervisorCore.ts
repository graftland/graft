/** Restart intensity as plain data: who may be restarted now, who waits, and who is escalated. */
import { Array as Arr, Cause, HashMap, HashSet, Option } from "effect"

import type {
	Command,
	Event,
	InstanceDownReason,
	PendingRestart,
	State,
	Supervision,
	SupervisionDeclaration,
	SupervisionFact,
	SupervisionPolicy,
	Working,
} from "./decisionState"
import * as Executions from "./executionState"

export const policy = (
	options: SupervisionDeclaration | undefined,
): SupervisionPolicy => ({
	backoff: {
		initial: Math.max(0, options?.backoff?.initial ?? 0),
		factor: Math.max(1, options?.backoff?.factor ?? 2),
		max: Math.max(0, options?.backoff?.max ?? 60_000),
	},
	intensity: Math.max(0, options?.intensity ?? 3),
	period: Math.max(1, options?.period ?? 60_000),
})
const blank: Supervision = { attempts: [], escalated: false }
export const get = (s: State, instance: string): Supervision =>
	Option.getOrElse(HashMap.get(s.supervision, instance), () => blank)
const progress = (s: State, instance: string): number =>
	Option.getOrElse(HashMap.get(s.restartBackoffs, instance), () => 0)
const recent = (s: State, instance: string): ReadonlyArray<number> =>
	Arr.filter(
		get(s, instance).attempts,
		(at) => at > s.now - s.supervisionPolicy.period,
	)
/** True when every instance is below its intensity and none is escalated. */
export const allows = (s: State, instances: HashSet.HashSet<string>): boolean =>
	HashSet.every(
		instances,
		(id) =>
			!get(s, id).escalated &&
			recent(s, id).length < s.supervisionPolicy.intensity,
	)
/** Records one attempted restart per instance; the record outlives every generation. */
export const attempted = (
	s: Working,
	instances: HashSet.HashSet<string>,
): Working => ({
	...s,
	restartBackoffs: HashSet.reduce(instances, s.restartBackoffs, (index, id) =>
		HashMap.set(index, id, progress(s, id) + 1),
	),
	supervision: HashSet.reduce(instances, s.supervision, (index, id) =>
		HashMap.set(index, id, {
			escalated: get(s, id).escalated,
			attempts: Arr.append(recent(s, id), s.now),
		}),
	),
})
/** Takes back the latest attempt: the restart never ran because admission was busy. */
export const refunded = (
	s: Working,
	instances: HashSet.HashSet<string>,
): Working => ({
	...s,
	restartBackoffs: HashSet.reduce(instances, s.restartBackoffs, (index, id) =>
		HashMap.set(index, id, Math.max(0, progress(s, id) - 1)),
	),
	supervision: HashSet.reduce(instances, s.supervision, (index, id) =>
		HashMap.has(index, id)
			? HashMap.set(index, id, {
					...get(s, id),
					attempts: Arr.dropRight(get(s, id).attempts, 1),
				})
			: index,
	),
})
/** Stops retrying the instances that exhausted their intensity; they stay observably failed. */
export const escalate = (
	s: Working,
	instances: HashSet.HashSet<string>,
): Working => ({
	...s,
	supervision: HashSet.reduce(instances, s.supervision, (index, id) =>
		HashMap.set(index, id, { ...get(s, id), escalated: true }),
	),
})
/** An accepted operator Change resets backoff and lifts escalation without erasing intensity history. */
export const cleared = (
	s: Working,
	instances: HashSet.HashSet<string>,
	reset = true,
): Working => {
	const lifted: Working = {
		...s,
		restartBackoffs: reset
			? HashSet.reduce(instances, s.restartBackoffs, (index, id) =>
					HashMap.remove(index, id),
				)
			: s.restartBackoffs,
		supervision: HashSet.reduce(instances, s.supervision, (index, id) =>
			HashMap.modify(index, id, (fact) => ({ ...fact, escalated: false })),
		),
	}
	return reset ? cancel(lifted, instances) : lifted
}
const restartKey = (restart: PendingRestart): string =>
	`${restart.kind}:${restart.unit}`
const timerCommand = (
	s: Working,
	restart: PendingRestart,
	id: string,
	kind: "ArmTimer" | "CancelTimer",
): Working =>
	Option.match(HashMap.get(s.units, restart.unit), {
		onNone: () => s,
		onSome: (unit) =>
			Option.match(Arr.head(Arr.fromIterable(HashMap.values(unit.members))), {
				onNone: () => s,
				onSome: (member) => {
					const command: Command = {
						id: `${id}/${kind}`,
						change: "$supervision",
						kind,
						unit: unit.id,
						participant: "",
						timer: Option.some(id),
						token: {
							authority: s.authority,
							change: "$supervision",
							unit: unit.id,
							incarnation: unit.incarnation,
							members: HashMap.empty(),
							view: 0,
						},
						subjects: restart.members,
						placement: unit.placement,
						target: member.target,
						members: HashMap.empty(),
						resolutions: HashMap.empty(),
						descriptions: HashMap.empty(),
						policies: HashMap.empty(),
						dispatched: true,
						status: Option.none(),
						disposition: "Pending",
						report: Option.none(),
					}
					return {
						...s,
						commands: HashMap.set(s.commands, command.id, command),
						emitted: Arr.append(s.emitted, command),
					}
				},
			}),
	})
/** Returns a waiting state only once per restart; busy retries reuse the elapsed timer. */
export const wait = (
	s: Working,
	restart: PendingRestart,
	instances: HashSet.HashSet<string>,
): Option.Option<Working> => {
	const previous = HashMap.get(s.pendingRestarts, restartKey(restart))
	if (Option.isSome(previous))
		return Option.some({
			...s,
			pendingRestarts: HashMap.set(s.pendingRestarts, restartKey(restart), {
				...previous.value,
				members: HashSet.union(previous.value.members, restart.members),
				cause: Cause.combine(previous.value.cause, restart.cause),
			}),
		})
	if (restart.timer !== undefined || HashSet.size(instances) === 0)
		return Option.none()
	const { initial, factor, max } = s.supervisionPolicy.backoff
	const delay = HashSet.reduce(instances, 0, (delay, id) =>
		Math.max(
			delay,
			initial === 0 ? 0 : Math.min(max, initial * factor ** progress(s, id)),
		),
	)
	if (delay === 0) return Option.none()
	const id = `${s.authority}/restart-timer/${s.nextRestartTimer}`
	return Option.some(
		timerCommand(
			{
				...s,
				nextRestartTimer: s.nextRestartTimer + 1,
				pendingRestarts: HashMap.set(s.pendingRestarts, restartKey(restart), {
					...restart,
					timer: id,
				}),
				timers: HashMap.set(s.timers, id, {
					id,
					change: "$supervision",
					purpose: "Restart",
					generation: s.nextRestartTimer,
					cause: Cause.empty,
					deadline: s.now + delay,
					active: true,
					command: Option.none(),
				}),
			},
			restart,
			id,
			"ArmTimer",
		),
	)
}
export const waiting = (s: State, restart: PendingRestart): boolean =>
	restart.timer !== undefined &&
	Option.exists(HashMap.get(s.timers, restart.timer), (t) => t.active)
/** Only the matching, due TimerFired releases a waiting restart. Timer failures retain their cause. */
export const observeTimer = (
	s: Working,
	event: Extract<Event, { _tag: "TimerFired" | "TimerEnded" }>,
): Working =>
	Option.match(HashMap.get(s.timers, event.timer), {
		onNone: () => s,
		onSome: (timer) => {
			if (
				timer.generation !== event.generation ||
				(event._tag === "TimerFired" &&
					(!timer.active || event.now < timer.deadline))
			)
				return s
			const observed: Working = {
				...s,
				timers: HashMap.set(s.timers, timer.id, {
					...timer,
					active: false,
					cause:
						event._tag === "TimerEnded"
							? Cause.combine(timer.cause, event.cause)
							: timer.cause,
				}),
			}
			if (event._tag === "TimerFired" || !timer.active) return observed
			return HashMap.reduce(
				s.pendingRestarts,
				observed,
				(next, restart, key) =>
					restart.timer === timer.id
						? {
								...escalate(next, restart.members),
								pendingRestarts: HashMap.remove(next.pendingRestarts, key),
							}
						: next,
			)
		},
	})
/** Shutdown cancels every wait; an accepted Change cancels only its members' stale restarts. */
export const cancel = (
	s: Working,
	instances?: HashSet.HashSet<string>,
): Working =>
	HashMap.reduce(s.pendingRestarts, s, (next, restart, key) => {
		const members =
			instances === undefined
				? HashSet.empty<string>()
				: HashSet.filter(
						restart.members,
						(id) =>
							!HashSet.has(instances, id) ||
							(HashMap.has(next.graph.declarations, id) &&
								!Executions.healthy(next, id)),
					)
		if (HashSet.size(members) > 0)
			return {
				...next,
				pendingRestarts: HashMap.set(next.pendingRestarts, key, {
					...restart,
					members,
				}),
			}
		const removed = {
			...next,
			pendingRestarts: HashMap.remove(next.pendingRestarts, key),
		}
		return restart.timer === undefined
			? removed
			: Option.match(HashMap.get(next.timers, restart.timer), {
					onNone: () => removed,
					onSome: (timer) =>
						timer.active
							? timerCommand(
									{
										...removed,
										timers: HashMap.set(removed.timers, timer.id, {
											...timer,
											active: false,
										}),
									},
									restart,
									timer.id,
									"CancelTimer",
								)
							: removed,
				})
	})
const reason = (
	s: State,
	instance: string,
): Option.Option<InstanceDownReason> => {
	if (
		!s.open ||
		Option.exists(HashMap.get(s.cells, instance), (c) =>
			Option.isSome(c.writer),
		)
	)
		return Option.none()
	const desired = HashMap.get(s.graph.declarations, instance)
	if (
		Option.exists(desired, (m) => !Executions.authorized(s, instance, m.target))
	)
		return Option.some("Revoked")
	const dependencies = Option.getOrElse(
		HashMap.get(s.graph.dependencies, instance),
		() => [],
	)
	const missing = Arr.some(
		dependencies,
		(d) =>
			!d.optional &&
			!Option.exists(d.provider, (id) => Executions.healthy(s, id)),
	)
	if (Executions.healthy(s, instance) && !missing) return Option.none()
	if (get(s, instance).escalated) return Option.some("Escalated")
	if (missing) return Option.some("WaitingForDependency")
	if (
		HashMap.some(s.pendingRestarts, (r) => HashSet.has(r.members, instance)) ||
		HashMap.some(
			s.preparations,
			(p) =>
				p.request.supervised !== undefined &&
				HashSet.has(p.request.supervised.members, instance),
		)
	)
		return Option.some("RestartPending")
	return Option.none()
}
export const facts = (s: State): ReadonlyArray<SupervisionFact> =>
	Arr.map(Arr.fromIterable(HashMap.keys(s.graph.declarations)), (instance) => ({
		instance,
		...get(s, instance),
		reason: reason(s, instance),
	}))
