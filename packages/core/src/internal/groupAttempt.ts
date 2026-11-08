/** Queries and schedules for one core-owned, complete group attempt. */
import { Array, HashMap, HashSet, Option } from "effect"

import type {
	Change,
	DeploymentGroup,
	Description,
	MemberDeclaration,
	ResolvedInput,
	State,
	Unit,
} from "./decisionState"

export const declarations = (
	change: Change,
): HashMap.HashMap<string, MemberDeclaration> =>
	change.recovering ? change.plan.previous : change.plan.desired
export const groups = (
	change: Change,
): HashMap.HashMap<string, DeploymentGroup> =>
	change.recovering ? change.plan.recoveryGroups : change.plan.newGroups
export const units = (change: Change): HashSet.HashSet<string> =>
	HashSet.fromIterable(HashMap.values(change.candidates))
export const current = (change: Change): Option.Option<MemberDeclaration> =>
	Option.flatMap(change.currentMember, (id) =>
		HashMap.get(declarations(change), id),
	)
export const resolution = (change: Change): Option.Option<ResolvedInput> =>
	Option.flatMap(change.currentMember, (id) =>
		HashMap.get(change.resolutions, id),
	)
export const description = (change: Change): Option.Option<Description> =>
	Option.flatMap(change.currentMember, (id) =>
		HashMap.get(change.descriptions, id),
	)
export const currentUnit = (
	state: State,
	change: Change,
): Option.Option<Unit> =>
	Option.flatMap(change.currentGroup, (group) =>
		Option.flatMap(HashMap.get(change.candidates, group), (id) =>
			HashMap.get(state.units, id),
		),
	)
export const groupFor = (
	change: Change,
	member: string,
): Option.Option<DeploymentGroup> =>
	Array.findFirst(HashMap.values(groups(change)), (group) =>
		HashSet.has(group.members, member),
	)
export const unitFor = (
	state: State,
	change: Change,
	member: string,
): Option.Option<Unit> =>
	Option.flatMap(groupFor(change, member), (group) =>
		Option.flatMap(HashMap.get(change.candidates, group.id), (id) =>
			HashMap.get(state.units, id),
		),
	)
export const nextGroup = (change: Change): Option.Option<DeploymentGroup> =>
	Array.findFirst(
		HashMap.values(groups(change)),
		(group) => !HashSet.has(change.loadedGroups, group.id),
	)
export const unresolved = (
	change: Change,
	group: DeploymentGroup,
): Option.Option<string> =>
	Array.findFirst(
		group.members,
		(member) => !HashMap.has(change.resolutions, member),
	)
export const currentMembers = (change: Change): HashSet.HashSet<string> =>
	Option.match(
		Option.flatMap(change.currentGroup, (group) =>
			HashMap.get(groups(change), group),
		),
		{ onNone: HashSet.empty<string>, onSome: (group) => group.members },
	)
