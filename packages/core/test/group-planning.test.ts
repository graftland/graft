import { Array, HashMap, HashSet, Option, Order, Result } from "effect"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore"
import * as Graph from "../src/internal/groupGraph"
import { explore } from "./change-model/explore"
import {
	accept,
	exit as exitUnit,
	fire,
	request,
} from "./change-model/scenarios"

const target = (identity: string): Core.Target => ({
	identity,
	placement: "Worker",
	overlap: true,
})
const declaration = (
	id: string,
	options: Partial<Core.MemberDeclaration> = {},
): Core.MemberDeclaration => ({
	instance: id,
	declaration: "self",
	parent: Option.none(),
	realm: "root",
	target: target(id),
	localProvides: [],
	localRequires: [],
	provides: [],
	requires: [],
	resources: [],
	colocate: [],
	placement: Option.none(),
	overlap: true,
	probes: [],
	...options,
})
const local = (key: string, optional = false) => ({ key, optional })
const contract = (
	operations: ReadonlyArray<string> = ["read@1"],
): Core.BindingDeclaration => ({
	key: "public/value",
	unary: true,
	operations: Array.map(operations, (identity) => ({
		identity,
		tag: identity,
		provenance: "shared-contract",
	})),
})
const initial = (
	members: ReadonlyArray<Core.MemberDeclaration>,
	maxUnits = 16,
) =>
	Core.make({
		authority: "group-planning",
		maxUnits,
		declarations: members,
		realms: Array.map(["root", "one", "two"], (id) => ({
			id,
			parent: id === "root" ? Option.none<string>() : Option.some("root"),
			isolated: HashSet.empty<string>(),
		})),
	})
const submit = (
	state: Core.State,
	proposed: ReadonlyArray<Core.MemberDeclaration>,
	explicit: ReadonlyArray<string> = ["a"],
	strategy: Core.Strategy = "Restart",
) =>
	Core.reduce(state, {
		_tag: "Submit",
		now: state.now,
		request: {
			instance: explicit[0] ?? "a",
			target: target("next"),
			strategy,
			reads: HashMap.fromIterable(
				Array.map(explicit, (id) => [id, Core.cell(state, id).version]),
			),
			writes: HashSet.fromIterable(explicit),
			leases: HashSet.empty(),
			participants: HashSet.empty(),
			budget: Core.defaultBudget,
			trial: 0,
			proposal: {
				members: proposed,
				removed: HashSet.empty(),
				explicit: HashSet.fromIterable(explicit),
				realms: [],
			},
		},
	})
const change = (result: Core.Transition) => {
	assert.equal(result.reply._tag, "Admitted")
	if (result.reply._tag !== "Admitted")
		return Option.getOrThrow(Option.none<Core.Change>())
	return Option.getOrThrow(
		HashMap.get(result.state.changes, result.reply.change),
	)
}
const members = (result: Core.Transition) =>
	Array.sort(Array.fromIterable(change(result).plan.members), Order.String)

it("closes split-to-merge groups repeatedly while retaining separate proposed groups and every reason (I2, I3, I4, F1)", () => {
	const old = [
		declaration("a", { localProvides: ["ab"] }),
		declaration("b", { localRequires: [local("ab")] }),
		declaration("c", { localProvides: ["cd"] }),
		declaration("d", { localRequires: [local("cd")] }),
	]
	const next = [
		declaration("a"),
		declaration("b", { localProvides: ["bc"] }),
		declaration("c", { localRequires: [local("bc")] }),
		declaration("d"),
	]
	const result = submit(initial(old), next)
	assert.deepEqual(members(result), ["a", "b", "c", "d"])
	const plan = change(result).plan
	assert.sameDeepMembers(
		Array.map(Array.fromIterable(HashMap.values(plan.newGroups)), (group) =>
			Array.sort(Array.fromIterable(group.members), Order.String),
		),
		[["a"], ["b", "c"], ["d"]],
	)
	assert.isAtLeast(
		HashSet.size(Option.getOrThrow(HashMap.get(plan.reasons, "b"))),
		2,
	)
	assert.isTrue(HashSet.has(change(result).request.writes, "d"))
})

it("separates structural containers, concrete local realms and compatible contract consumers (I2, I3)", () => {
	const state = initial([
		declaration("a", {
			realm: "one",
			localProvides: ["value"],
			provides: [contract(["read@1", "write@1"])],
		}),
		declaration("b", { realm: "two", localProvides: ["value"] }),
		declaration("c", { realm: "one", localRequires: [local("value")] }),
		declaration("d", { realm: "two", localRequires: [local("value")] }),
		declaration("g", {
			realm: "one",
			requires: [{ ...contract(), optional: false }],
		}),
	])
	const result = submit(state, [
		declaration("a", {
			realm: "one",
			localProvides: ["value"],
			provides: [contract()],
			target: target("next"),
		}),
	])
	assert.deepEqual(members(result), ["a", "c"])
	assert.isFalse(HashSet.has(change(result).plan.members, "b"))
	assert.isFalse(HashSet.has(change(result).plan.members, "d"))
	assert.isFalse(HashSet.has(change(result).plan.members, "g"))
	const consumer = Option.getOrThrow(HashMap.get(state.instances, "g"))
	assert.isTrue(
		Option.exists(consumer.current, (id) =>
			HashSet.has(change(result).plan.participants, id),
		),
	)
})

it("expands declared descendants and then their local groups to the same closure fixpoint (I4, F1)", () => {
	const child = declaration("s", {
		parent: Option.some("a"),
		declaration: "scope-child",
		localProvides: ["child-value"],
	})
	const state = initial([
		declaration("a"),
		child,
		declaration("q", { localRequires: [local("child-value")] }),
	])
	const result = submit(state, [declaration("a", { target: target("next") })])
	assert.deepEqual(members(result), ["a", "q", "s"])
	const plan = change(result).plan
	assert.isTrue(
		Array.some(
			Array.fromIterable(HashMap.values(plan.newGroups)),
			(group) =>
				HashSet.has(group.members, "a") &&
				HashSet.has(group.members, "s") &&
				HashSet.has(group.members, "q"),
		),
	)
})

it("rejects conflicting explicit placement only after full old/new closure without creating a Change (I3, I4, F1)", () => {
	const state = initial([
		declaration("a", { localProvides: ["value"] }),
		declaration("b", { localRequires: [local("value")] }),
	])
	const result = submit(state, [
		declaration("a", {
			localProvides: ["value"],
			placement: Option.some({ kind: "Worker" }),
		}),
		declaration("b", {
			placement: Option.some({ kind: "Process" }),
			localRequires: [local("value")],
		}),
	])
	assert.equal(result.reply._tag, "Rejected")
	if (result.reply._tag === "Rejected")
		assert.equal(result.reply.reason, "PlacementConflict")
	assert.equal(HashMap.size(result.state.changes), 0)
	assert.isFalse(Array.some(result.commands, (c) => c.kind === "Stop"))
})

it("reserves every old/new membership and optional-absence premise before dispatch (I5, F1, F6)", () => {
	const state = initial([
		declaration("a", {
			localProvides: ["join"],
			localRequires: [local("optional", true)],
		}),
		declaration("b", { localRequires: [local("join")] }),
		declaration("c"),
	])
	const result = submit(state, [
		declaration("a", {
			localRequires: [local("optional", true)],
			target: target("next"),
		}),
		declaration("b"),
	])
	const planned = change(result)
	assert.isAtLeast(HashSet.size(planned.plan.membershipCells), 3)
	assert.isAtLeast(HashSet.size(planned.plan.absenceCells), 1)
	for (const key of planned.plan.membershipCells)
		assert.isTrue(HashMap.has(planned.premises, key))
	for (const key of planned.plan.absenceCells)
		assert.isTrue(HashMap.has(planned.premises, key))
	const conflicting = submit(
		result.state,
		[declaration("c", { localProvides: ["optional"] })],
		["c"],
	)
	assert.equal(conflicting.reply._tag, "Rejected")
	if (conflicting.reply._tag === "Rejected")
		assert.equal(conflicting.reply.reason, "Busy")
})

it.each(["provider", "cycle", "overlap"])(
	"rejects an invalid complete %s plan before old lifecycle actions (I3, I4, I5, F1)",
	(fault) => {
		const state = initial([declaration("a"), declaration("b")])
		const proposed =
			fault === "provider"
				? [declaration("a", { localRequires: [local("absent")] })]
				: fault === "cycle"
					? [
							declaration("a", {
								localProvides: ["a"],
								localRequires: [local("b")],
							}),
							declaration("b", {
								localProvides: ["b"],
								localRequires: [local("a")],
							}),
						]
					: [declaration("a", { overlap: false })]
		const result = submit(
			state,
			proposed,
			["a"],
			fault === "overlap" ? "Overlap" : "Restart",
		)
		assert.equal(result.reply._tag, "Rejected")
		if (result.reply._tag === "Rejected")
			assert.equal(
				result.reply.reason,
				fault === "provider"
					? "MissingProvider"
					: fault === "cycle"
						? "DependencyCycle"
						: "IneligibleOverlap",
			)
		assert.equal(HashMap.size(result.state.changes), 0)
		assert.isFalse(Array.some(result.commands, (c) => c.kind === "Stop"))
	},
)

it("reserves a split's three distinct forward and recovery slots once instead of charging shared old members twice (I5, F1)", () => {
	const old = [
		declaration("a", { localProvides: ["ab"] }),
		declaration("b", { localRequires: [local("ab")] }),
		declaration("c", { localProvides: ["cd"] }),
		declaration("d", { localRequires: [local("cd")] }),
	]
	const next = [
		declaration("a"),
		declaration("b", { localProvides: ["bc"] }),
		declaration("c", { localRequires: [local("bc")] }),
		declaration("d"),
	]
	const state = initial(old, 3)
	assert.equal(HashMap.size(state.claims), 2)
	const result = submit(state, next)
	const selected = change(result)
	assert.equal(selected.plan.peakUnits, 3)
	assert.equal(HashSet.size(selected.claims), 3)
	assert.equal(HashMap.size(result.state.claims), 3)
	const refused = submit(initial(old, 2), next)
	assert.equal(refused.reply._tag, "Rejected")
	if (refused.reply._tag === "Rejected")
		assert.equal(refused.reply.reason, "Capacity")
	assert.equal(HashMap.size(refused.state.changes), 0)
	assert.isFalse(Array.some(refused.commands, (c) => c.kind === "Stop"))
})

it("admits initial additions and deletion-only closures with identified desired and actual member facts (I2, I4, I5)", () => {
	const empty = initial([])
	const added = submit(empty, [declaration("a")])
	const initialChange = change(added)
	assert.deepEqual(Array.fromIterable(initialChange.plan.members), ["a"])
	assert.isTrue(HashMap.has(initialChange.plan.desired, "a"))
	assert.isFalse(HashMap.has(initialChange.plan.previous, "a"))
	const before = initial([declaration("a")])
	const removed = Core.reduce(before, {
		_tag: "Submit",
		request: {
			instance: "a",
			target: target("removed"),
			strategy: "Restart",
			reads: HashMap.make(["a", Core.cell(before, "a").version]),
			writes: HashSet.make("a"),
			leases: HashSet.empty(),
			participants: HashSet.empty(),
			budget: Core.defaultBudget,
			trial: 0,
			proposal: {
				members: [],
				removed: HashSet.make("a"),
				explicit: HashSet.make("a"),
				realms: [],
			},
		},
		now: 0,
	})
	const deleted = change(removed)
	assert.equal(HashMap.size(deleted.plan.desired), 0)
	assert.equal(HashMap.size(deleted.plan.newGroups), 0)
	const status = Option.getOrThrow(Core.get(removed.state, deleted.id))
	const member = Option.getOrThrow(HashMap.get(status.members, "a"))
	assert.isTrue(Option.isNone(member.desired))
	assert.isTrue(Option.isSome(member.starting))
})

it("snapshots every admitted declaration and proposal instead of retaining caller-owned arrays (I4, I5)", () => {
	const services = ["private/value"]
	const proposed = [declaration("a", { localProvides: services })]
	const result = submit(initial([declaration("a")]), proposed)
	const admitted = change(result)
	services.push("unreserved/service")
	proposed.push(declaration("unreserved-member"))
	assert.equal(admitted.plan.proposal.members.length, 1)
	assert.equal(admitted.request.proposal?.members.length, 1)
	assert.deepEqual(admitted.plan.proposal.members[0]?.localProvides, [
		"private/value",
	])
	assert.deepEqual(
		Option.getOrThrow(HashMap.get(admitted.plan.desired, "a")).localProvides,
		["private/value"],
	)
})

it("applies only a plan's reserved graph patch while preserving an unrelated committed deployment (I5, F6)", () => {
	const base = initial([declaration("a"), declaration("b")])
	const a = change(submit(base, [declaration("a", { target: target("a2") })]))
	const b = change(
		submit(base, [declaration("b", { target: target("b2") })], ["b"]),
	)
	const withB = Graph.commit(base.graph, b.plan, false)
	const withA = Graph.commit(withB, a.plan, false)
	assert.equal(
		Option.getOrThrow(HashMap.get(withA.declarations, "b")).target.identity,
		"b2",
	)
	assert.equal(
		Option.getOrThrow(HashMap.get(withA.declarations, "a")).target.identity,
		"a2",
	)
	const recovered = Graph.commit(withA, a.plan, true)
	assert.equal(
		Option.getOrThrow(HashMap.get(recovered.declarations, "a")).target.identity,
		"a",
	)
	assert.equal(
		Option.getOrThrow(HashMap.get(recovered.declarations, "b")).target.identity,
		"b2",
	)
})

it("reserves realm ancestry and optional-absence cells even when no provider exists (I2, I5, F6)", () => {
	const base = initial([
		declaration("a", { realm: "one", localRequires: [local("missing", true)] }),
	])
	const result = Graph.plan(
		base,
		{
			members: [
				declaration("a", {
					realm: "one",
					localRequires: [local("missing", true)],
				}),
			],
			explicit: HashSet.make("a"),
			removed: HashSet.empty(),
			realms: [],
		},
		"Restart",
	)
	assert.isTrue(Result.isSuccess(result))
	if (Result.isFailure(result)) return
	assert.isTrue(HashSet.has(result.success.reads, "realm:one"))
	assert.isTrue(HashSet.has(result.success.reads, "realm:root"))
	assert.equal(HashSet.size(result.success.absenceCells), 2)
})

it("recloses both graphs when a realm ancestry edit redirects an existing local capture (I2, I4, I5, F1, F6)", () => {
	const child: Core.RealmDeclaration = {
		id: "child",
		parent: Option.some("one"),
		isolated: HashSet.empty(),
	}
	const initialized = Graph.initialize(
		[
			declaration("a", { realm: "one", localProvides: ["value"] }),
			declaration("b", { realm: "two", localProvides: ["value"] }),
			declaration("x", { realm: "child", localRequires: [local("value")] }),
			declaration("z"),
		],
		[...HashMap.values(initial([]).graph.realms), child],
	)
	assert.isTrue(Result.isSuccess(initialized))
	if (Result.isFailure(initialized)) return
	const state = { ...initial([]), graph: initialized.success }
	const planned = Graph.plan(
		state,
		{
			members: [declaration("z")],
			removed: HashSet.empty(),
			explicit: HashSet.make("z"),
			realms: [{ ...child, parent: Option.some("two") }],
		},
		"Restart",
	)
	assert.isTrue(Result.isSuccess(planned))
	if (Result.isFailure(planned)) return
	assert.sameMembers(Array.fromIterable(planned.success.members), [
		"a",
		"b",
		"x",
		"z",
	])
	const desired = Array.fromIterable(HashMap.values(planned.success.newGroups))
	assert.isTrue(
		Array.some(
			desired,
			(g) => HashSet.has(g.members, "b") && HashSet.has(g.members, "x"),
		),
	)
	assert.isTrue(HashSet.has(planned.success.writes, "realm:child"))
})

it("checks authorization for every collateral member before reserving or stopping the closure (I5, F1)", () => {
	const base = initial([
		declaration("a", { colocate: ["private"] }),
		declaration("b", { colocate: ["private"] }),
	])
	const denied = Core.reduce(base, {
		_tag: "PolicyChanged",
		instance: "b",
		allowed: [],
		values: {},
		now: 0,
	}).state
	const result = submit(denied, [
		declaration("a", { colocate: ["private"], target: target("next") }),
	])
	assert.equal(result.reply._tag, "Rejected")
	if (result.reply._tag === "Rejected")
		assert.equal(result.reply.reason, "Unauthorized")
	assert.equal(HashMap.size(result.state.changes), 0)
	assert.isFalse(Array.some(result.commands, (c) => c.kind === "Stop"))
})

it("explores every conflicting split, optional-provider creation and shutdown order through the production reducer (I2, I4, I5, F1, F6)", () => {
	const base = initial([
		declaration("a", {
			localProvides: ["join"],
			localRequires: [local("optional", true)],
		}),
		declaration("b", { localRequires: [local("join")] }),
		declaration("c"),
	])
	const event = (
		state: Core.State,
		id: string,
		members: ReadonlyArray<Core.MemberDeclaration>,
	): Core.Event => ({
		_tag: "Submit",
		now: state.now,
		request: {
			...request(state, id, "Restart"),
			proposal: {
				members,
				explicit: HashSet.make(id),
				removed: HashSet.empty(),
				realms: [],
			},
		},
	})
	const stats = explore(
		base,
		[
			[
				{
					name: "Split",
					event: (s) =>
						event(s, "a", [
							declaration("a", { localRequires: [local("optional", true)] }),
							declaration("b"),
						]),
				},
			],
			[
				{
					name: "Optional provider",
					event: (s) =>
						event(s, "c", [declaration("c", { localProvides: ["optional"] })]),
				},
			],
			[{ name: "Shutdown", event: (s) => ({ _tag: "Shutdown", now: s.now }) }],
		],
		(s) => {
			assert.isFalse(s.open)
			assert.isAtMost(HashMap.size(s.changes), 1)
			for (const change of HashMap.values(s.changes))
				for (const key of change.plan.writes)
					assert.isTrue(Option.contains(Core.cell(s, key).writer, change.id))
		},
	)
	assert.deepEqual(stats, { schedules: 6, states: 16, transitions: 15 })
})

it("rejects an optional-absence ABA after real provider creation and deletion have both settled (I2, I4, I5, F6)", () => {
	const before = initial([declaration("a"), declaration("b"), declaration("c")])
	const key = Graph.slot("root", "Local", "optional")
	const stale = {
		...request(before, "a", "Restart"),
		reads: HashMap.make(
			["a", Core.cell(before, "a").version],
			[key, Core.cell(before, key).version],
		),
		proposal: {
			members: [declaration("a", { localRequires: [local("optional", true)] })],
			explicit: HashSet.make("a"),
			removed: HashSet.empty<string>(),
			realms: [],
		},
	}
	const first = submit(
		before,
		[declaration("b", { target: target("next"), localProvides: ["optional"] })],
		["b"],
	)
	const created = accept(
		exitUnit(first.state, "b@0", { _tag: "Completed" }),
		change(first).id,
	)
	assert.equal(Core.cell(created, key).version, 1)
	const deletion = Core.reduce(created, {
		_tag: "Submit",
		now: created.now,
		request: {
			...request(created, "b", "Restart"),
			proposal: {
				members: [],
				removed: HashSet.make("b"),
				explicit: HashSet.make("b"),
				realms: [],
			},
		},
	})
	const removed = fire(
		exitUnit(deletion.state, "b@1", { _tag: "Completed" }),
		change(deletion).id,
		"Trial",
	)
	const completed = Option.getOrThrow(Core.get(removed, change(deletion).id))
	assert.equal(Option.getOrThrow(completed.conclusion).outcome, "Accepted")
	assert.isTrue(
		Option.isNone(
			Option.getOrThrow(HashMap.get(completed.members, "b")).desired,
		),
	)
	assert.isTrue(
		Option.isNone(
			Option.getOrThrow(HashMap.get(removed.instances, "b")).current,
		),
	)
	assert.equal(Core.cell(removed, key).version, 2)
	const refused = Core.reduce(removed, {
		_tag: "Submit",
		request: stale,
		now: removed.now,
	})
	assert.equal(refused.reply._tag, "Rejected")
	if (refused.reply._tag === "Rejected") {
		assert.equal(refused.reply.reason, "Stale")
		assert.isTrue(HashSet.has(refused.reply.conflicts, key))
	}
	assert.isFalse(Array.some(refused.commands, (c) => c.kind === "Stop"))
})

it("rejects a changed declaration outside the derived replacement closure instead of borrowing its unreserved future contract (I4, I5, F3)", () => {
	const base = initial([
		declaration("a", { requires: [{ ...contract(), optional: false }] }),
		declaration("d", { provides: [contract()] }),
	])
	const result = submit(base, [
		declaration("a", {
			requires: [{ ...contract(["write@1"]), optional: false }],
		}),
		declaration("d", { provides: [contract(["read@1", "write@1"])] }),
	])
	assert.equal(result.reply._tag, "Rejected")
	if (result.reply._tag === "Rejected")
		assert.equal(result.reply.reason, "InvalidDeclaration")
	assert.equal(HashMap.size(result.state.changes), 0)
	assert.isFalse(Array.some(result.commands, (c) => c.kind === "Stop"))
})

it("reserves and stages a compatible external contract consumer redirected by a realm edit without replacing that consumer (I2, I4, I5, F6)", () => {
	const child: Core.RealmDeclaration = {
		id: "child",
		parent: Option.some("one"),
		isolated: HashSet.empty(),
	}
	const realms = [...HashMap.values(initial([]).graph.realms), child]
	const base = Core.make({
		authority: "realm-contract",
		maxUnits: 8,
		realms,
		declarations: [
			declaration("a", { realm: "one", provides: [contract()] }),
			declaration("b", { realm: "two", provides: [contract()] }),
			declaration("g", {
				realm: "child",
				requires: [{ ...contract(), optional: false }],
			}),
			declaration("z"),
		],
	})
	const result = Graph.plan(
		base,
		{
			members: [declaration("z")],
			explicit: HashSet.make("z"),
			removed: HashSet.empty(),
			realms: [{ ...child, parent: Option.some("two") }],
		},
		"Restart",
	)
	assert.isTrue(Result.isSuccess(result))
	if (Result.isFailure(result)) return
	const plan = result.success
	assert.sameMembers(Array.fromIterable(plan.members), ["z"])
	assert.isTrue(HashSet.has(plan.writes, "binding:1:g:public/value"))
	assert.isTrue(
		Option.exists(
			Option.getOrThrow(HashMap.get(base.instances, "g")).current,
			(u) => HashSet.has(plan.participants, u),
		),
	)
	assert.equal(
		Option.getOrThrow(
			Array.head(Option.getOrThrow(HashMap.get(plan.dependencies, "g"))),
		).provider.pipe(Option.getOrThrow),
		"b",
	)
})

it.each(["cycle", "missing parent"])(
	"rejects a realm %s even when every unresolved service is optional (I2, I5, F6)",
	(fault) => {
		const base = initial([declaration("a")])
		const realms: ReadonlyArray<Core.RealmDeclaration> =
			fault === "cycle"
				? [
						{
							id: "one",
							parent: Option.some("two"),
							isolated: HashSet.empty(),
						},
						{
							id: "two",
							parent: Option.some("one"),
							isolated: HashSet.empty(),
						},
					]
				: [
						{
							id: "one",
							parent: Option.some("absent"),
							isolated: HashSet.empty(),
						},
					]
		const result = Graph.plan(
			base,
			{
				members: [
					declaration("a", {
						realm: "one",
						localRequires: [local("optional", true)],
					}),
				],
				explicit: HashSet.make("a"),
				removed: HashSet.empty(),
				realms,
			},
			"Restart",
		)
		assert.isTrue(Result.isFailure(result))
		if (Result.isFailure(result))
			assert.equal(result.failure.reason, "InvalidDeclaration")
	},
)

it.each(["member", "resource", "placement"])(
	"rejects Overlap when an old moved %s disallows it even if its new declaration permits it (I3, I4, I5, F1)",
	(kind) => {
		const base = initial([
			declaration(
				"a",
				kind === "member"
					? { overlap: false }
					: kind === "placement"
						? {
								placement: Option.some<Core.PlacementRequirement>({
									kind: "Runner",
								}),
							}
						: {
								resources: [
									{ key: "exclusive", mode: "Exclusive", overlap: false },
								],
							},
			),
		])
		const result = submit(
			base,
			[
				declaration("a", {
					target: target("next"),
					resources: [{ key: "exclusive", mode: "Exclusive", overlap: true }],
				}),
			],
			["a"],
			"Overlap",
		)
		assert.equal(result.reply._tag, "Rejected")
		if (result.reply._tag === "Rejected")
			assert.equal(result.reply.reason, "IneligibleOverlap")
		assert.isFalse(
			Array.some(
				result.commands,
				(c) => c.kind === "Spawn" || c.kind === "Stop",
			),
		)
	},
)
