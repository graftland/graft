import { Array, HashMap, HashSet, Option } from "effect"
import { assert } from "@effect/vitest"

import type * as Core from "../src/internal/decisionCore"

/** Projects the sole member in a fixture that explicitly has one member. */
export const oneMember = (value: {
	readonly members: HashMap.HashMap<string, Core.MemberFact>
}): Core.MemberFact => {
	assert.equal(HashMap.size(value.members), 1)
	return Option.getOrThrow(
		Array.head(Array.fromIterable(HashMap.values(value.members))),
	)
}
export const declaredMembers = (
	entries: ReadonlyArray<{ readonly id: string; readonly target: Core.Target }>,
): ReadonlyArray<Core.MemberDeclaration> =>
	Array.map(entries, (entry) => ({
		instance: entry.id,
		declaration: "self",
		parent: Option.none(),
		realm: "root",
		target: entry.target,
		localProvides: [],
		localRequires: [],
		provides: [],
		requires: [],
		resources: [],
		colocate: [],
		placement: Option.some({ kind: entry.target.placement }),
		overlap: entry.target.overlap,
		probes: [],
	}))
export const rootRealms: ReadonlyArray<Core.RealmDeclaration> = [
	{ id: "root", parent: Option.none(), isolated: HashSet.empty() },
]
