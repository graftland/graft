/** Restart intensity as plain data: who may be restarted now, who waits, and who is escalated. */
import { Array as Arr, HashMap, HashSet, Option } from "effect"

import type {
	State,
	Supervision,
	SupervisionDeclaration,
	SupervisionPolicy,
	Working,
} from "./decisionState"

export const policy = (
	options: SupervisionDeclaration | undefined,
): SupervisionPolicy => ({
	intensity: Math.max(0, options?.intensity ?? 3),
	period: Math.max(1, options?.period ?? 60_000),
})
const blank: Supervision = { attempts: [], escalated: false }
export const get = (s: State, instance: string): Supervision =>
	Option.getOrElse(HashMap.get(s.supervision, instance), () => blank)
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
/** An accepted Change lifts escalation; the attempt history is kept, so a new generation does not reset it. */
export const cleared = (
	s: Working,
	instances: HashSet.HashSet<string>,
): Working => ({
	...s,
	supervision: HashSet.reduce(instances, s.supervision, (index, id) =>
		HashMap.has(index, id)
			? HashMap.set(index, id, { ...get(s, id), escalated: false })
			: index,
	),
})
