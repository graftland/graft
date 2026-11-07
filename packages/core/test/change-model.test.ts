import {
	Array as Arr,
	Cause,
	Effect,
	Equal,
	HashMap,
	HashSet,
	Option,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import {
	conclusion,
	invariant,
	run,
	stepChecked,
	transition,
} from "./change-model/assertions.ts"
import { explore, reachable } from "./change-model/explore.ts"
import {
	Action,
	cell,
	change,
	generation,
	ObjectKey,
	step,
	type Model,
} from "./change-model/model.ts"
import {
	accepting,
	activate,
	exit,
	fixture,
	independent,
	instance,
	plan,
	slot,
	token,
} from "./change-model/scenarios.ts"

const ready = (s: Model, id: string, member: string): Model =>
	run(s, [
		Action.Submit({ plan: plan(s, id, [{ id: member }]) }),
		Action.Prepare({ change: id }),
		Action.Install({ change: id }),
		Action.Acknowledge({ token: token(id, member) }),
	])
const facts = (s: Model, id: string) =>
	Option.getOrThrow(change(s, id).conclusion)
const count = (s: Model) =>
	HashMap.reduce(s.accesses, 0, (total, value) => total + value)
const settleClosed = (s: Model): Model =>
	HashMap.reduce(s.changes, s, (state, c) => {
		if (Option.isSome(c.conclusion)) return state
		const cancelled = run(state, [Action.Cancel({ change: c.plan.id })])
		const stopped = HashSet.reduce(cancelled.stopping, cancelled, (acc, id) =>
			run(acc, exit(id)),
		)
		const phase = change(stopped, c.plan.id).phase
		return run(stopped, [
			...(phase === "Recovering"
				? [Action.Recover({ change: c.plan.id, allowed: false })]
				: []),
			Action.Finish({ change: c.plan.id }),
		])
	})

describe("concurrent Change protocol model", () => {
	it.effect(
		"retains leased consumers in a Stuck conflict set while unrelated work completes",
		() =>
			Effect.sync(() => {
				const specs = [
					{ id: "a", dependencies: [{ provider: "b", optional: false }] },
					{ id: "b" },
				]
				const initial = fixture([...specs, { id: "c" }])
				const stuck = run(initial, [
					Action.Submit({ plan: plan(initial, "A", specs) }),
					Action.Prepare({ change: "A" }),
					Action.Install({ change: "A" }),
					Action.Acknowledge({ token: token("A", "a") }),
					Action.Acknowledge({ token: token("A", "b") }),
					Action.Commit({ change: "A" }),
					Action.Deadline({ change: "A" }),
				])
				conclusion(stuck, "A", "Stuck")
				assert.strictEqual(
					stepChecked(
						stuck,
						Action.Submit({ plan: plan(stuck, "C", [{ id: "a" }]) }),
					).decision,
					"Busy",
				)
				const done = run(stuck, accepting(plan(stuck, "B", [{ id: "c" }]), "c"))
				conclusion(done, "B", "Accepted")
				assert.isTrue(HashSet.has(generation(done, "a#0").leases, "b#0"))
			}),
	)

	it.effect(
		"reaches an outcome at the budget boundary for every bounded lease cleanup interleaving",
		() =>
			Effect.sync(() => {
				const specs = [
					{ id: "a", dependencies: [{ provider: "b", optional: false }] },
					{ id: "b" },
				]
				const base = fixture(specs)
				const initial = run(base, [
					Action.Submit({ plan: plan(base, "A", specs) }),
					Action.Prepare({ change: "A" }),
					Action.Install({ change: "A" }),
					Action.Acknowledge({ token: token("A", "a") }),
					Action.Acknowledge({ token: token("A", "b") }),
				])
				const states = reachable(
					initial,
					[
						Action.Cancel({ change: "A" }),
						Action.Commit({ change: "A" }),
						Action.Evidence({ generation: "a#0", evidence: "Exited" }),
						Action.Evidence({ generation: "b#0", evidence: "Exited" }),
						Action.Evidence({ generation: "a#1", evidence: "Exited" }),
						Action.Evidence({ generation: "b#1", evidence: "Exited" }),
						Action.Deadline({ change: "A" }),
					],
					4,
					transition,
				)
				assert.isAbove(HashSet.size(states), 30)
				for (const s of states) {
					const ended = run(s, [Action.Deadline({ change: "A" })])
					assert.isTrue(Option.isSome(change(ended, "A").conclusion))
				}
			}),
	)

	it.effect(
		"settles exited generations leases without claiming finalizer success",
		() =>
			Effect.sync(() => {
				const specs = [
					{ id: "a", dependencies: [{ provider: "b", optional: false }] },
					{ id: "b" },
				]
				const initial = fixture(specs)
				const prepared = run(initial, [
					Action.Submit({ plan: plan(initial, "A", specs, "Restart") }),
					Action.Prepare({ change: "A" }),
					Action.StopOld({ change: "A" }),
					Action.Cancel({ change: "A" }),
				])
				// Counterexample to recording exit without reconciling generation leases.
				const missingReconciliation = {
					...prepared,
					generations: HashMap.set(
						HashMap.set(prepared.generations, "a#0", {
							...generation(prepared, "a#0"),
							evidence: "Exited",
						}),
						"b#0",
						{ ...generation(prepared, "b#0"), evidence: "Exited" },
					),
				} satisfies Model
				assert.strictEqual(
					step(missingReconciliation, Action.Deadline({ change: "A" }))
						.decision,
					"Blocked",
				)
				const providerExited = run(prepared, [
					Action.Evidence({ generation: "b#0", evidence: "Exited" }),
				])
				assert.strictEqual(
					stepChecked(providerExited, Action.Retire({ generation: "b#0" }))
						.decision,
					"Blocked",
				)
				const consumerExited = run(providerExited, [
					Action.Evidence({
						generation: "a#0",
						evidence: "Exited",
						cause: Cause.fail("Finalizer completion is unknown"),
					}),
				])
				assert.strictEqual(
					HashSet.size(generation(consumerExited, "a#0").leases),
					0,
				)
				const done = run(consumerExited, [Action.Deadline({ change: "A" })])
				conclusion(done, "A", "RecoveryFailed")
				const member = HashMap.getUnsafe(facts(done, "A").members, "a")
				assert.strictEqual(
					HashMap.getUnsafe(member.termination, "a#0").cleanup,
					"Unknown",
				)
				assert.isTrue(
					Arr.some(
						facts(done, "A").cause.reasons,
						(reason) =>
							reason._tag === "Fail" &&
							reason.error === "Finalizer completion is unknown",
					),
				)
			}),
	)

	it.effect(
		"waits for affected nonmember participants without a global barrier",
		() =>
			Effect.sync(() => {
				const initial = fixture()
				const base = plan(initial, "A", [{ id: "a" }])
				const p = {
					...base,
					participants: HashSet.make("b#0"),
					reads: HashMap.set(
						base.reads,
						instance("b"),
						cell(initial, instance("b")),
					),
				}
				const staged = run(initial, [
					Action.Submit({ plan: p }),
					Action.Prepare({ change: "A" }),
					Action.Install({ change: "A" }),
					Action.Acknowledge({ token: token("A", "a") }),
				])
				assert.strictEqual(
					stepChecked(staged, Action.Commit({ change: "A" })).decision,
					"Blocked",
				)
				assert.strictEqual(
					stepChecked(staged, Action.Acknowledge({ token: token("A", "c", 0) }))
						.decision,
					"RejectedAck",
				)
				const done = run(staged, [
					Action.Acknowledge({ token: token("A", "b", 0) }),
					Action.Commit({ change: "A" }),
					...exit("a#0"),
					Action.Finish({ change: "A" }),
				])
				conclusion(done, "A", "Accepted")
				assert.strictEqual(HashMap.size(change(done, "A").plan.members), 1)
				assert.strictEqual(
					Option.getOrThrow(cell(done, instance("b")).value),
					"b#0",
				)
			}),
	)

	it.effect(
		"preserves both patches in every interleaving from the same base",
		() =>
			Effect.sync(() => {
				const stats = explore(independent(), {
					transition,
					terminal: (s) => {
						conclusion(s, "A", "Accepted")
						conclusion(s, "B", "Accepted")
						assert.strictEqual(
							Option.getOrThrow(cell(s, instance("a")).value),
							"a#1",
						)
						assert.strictEqual(
							Option.getOrThrow(cell(s, instance("b")).value),
							"b#1",
						)
						assert.strictEqual(cell(s, instance("a")).version, 2)
						assert.strictEqual(cell(s, instance("b")).version, 2)
					},
				})
				assert.strictEqual(stats.schedules, 12870)
			}),
		60000,
	)

	it.effect(
		"reserves complete conflict sets atomically across three competing changes",
		() =>
			Effect.sync(() => {
				const initial = fixture()
				const actors = Arr.map(
					[
						plan(initial, "A", [{ id: "a" }, { id: "b" }]),
						plan(initial, "B", [{ id: "b" }, { id: "c" }]),
						plan(initial, "C", [{ id: "a" }, { id: "c" }]),
					],
					(p) => [
						Action.Submit({ plan: p }),
						Action.Cancel({ change: p.id }),
						Action.Finish({ change: p.id }),
					],
				)
				const stats = explore(
					{ name: "atomic admission", initial, actors },
					{
						transition,
						terminal: (s) => {
							assert.isAtLeast(HashMap.size(s.changes), 1)
							for (const id of HashMap.keys(s.changes))
								conclusion(s, id, "Aborted")
						},
					},
				)
				assert.strictEqual(stats.schedules, 1680)
			}),
		60000,
	)

	it.effect(
		"recovers only owned patches while an unrelated change commits",
		() =>
			Effect.sync(() => {
				const initial = ready(ready(fixture(), "A", "a"), "B", "b")
				const stats = explore(
					{
						name: "concurrent recovery",
						initial,
						actors: [
							[
								Action.Commit({ change: "A" }),
								Action.Cancel({ change: "A" }),
								...exit("a#0"),
								...exit("a#1"),
								Action.Recover({ change: "A", allowed: true }),
								...activate("A", "a", 2, 2),
								Action.Finish({ change: "A" }),
							],
							[
								Action.Commit({ change: "B" }),
								...exit("b#0"),
								Action.Finish({ change: "B" }),
							],
						],
					},
					{
						transition,
						terminal: (s) => {
							conclusion(s, "A", "Recovered")
							conclusion(s, "B", "Accepted")
							assert.strictEqual(generation(s, "a#2").config, "original")
							assert.strictEqual(
								Option.getOrThrow(cell(s, instance("b")).value),
								"b#1",
							)
							assert.strictEqual(cell(s, instance("a")).version, 3)
							assert.strictEqual(cell(s, instance("b")).version, 2)
						},
					},
				)
				assert.strictEqual(stats.schedules, 1365)
			}),
		60000,
	)

	it.effect(
		"keeps Stuck local with constant admission and commit object probes",
		() =>
			Effect.sync(() => {
				const measurements = Arr.map([0, 20, 200], (size) => {
					const initial = fixture([
						{ id: "a" },
						{ id: "b" },
						...Arr.makeBy(size, (i) => ({ id: `unrelated-${i}` })),
					])
					const stuck = run(ready(initial, "A", "a"), [
						Action.Commit({ change: "A" }),
						Action.Deadline({ change: "A" }),
					])
					conclusion(stuck, "A", "Stuck")
					assert.strictEqual(
						stepChecked(
							stuck,
							Action.Submit({ plan: plan(stuck, "C", [{ id: "a" }]) }),
						).decision,
						"Busy",
					)
					const admitted = stepChecked(
						{ ...stuck, accesses: HashMap.empty() },
						Action.Submit({ plan: plan(stuck, "B", [{ id: "b" }]) }),
					)
					assert.strictEqual(admitted.decision, "Applied")
					const staged = run(admitted.state, [
						Action.Prepare({ change: "B" }),
						Action.Install({ change: "B" }),
						Action.Acknowledge({ token: token("B", "b") }),
					])
					const committed = stepChecked(
						{ ...staged, accesses: HashMap.empty() },
						Action.Commit({ change: "B" }),
					)
					assert.strictEqual(committed.decision, "Applied")
					const done = run(committed.state, [
						...exit("b#0"),
						Action.Finish({ change: "B" }),
					])
					conclusion(done, "B", "Accepted")
					for (const key of HashMap.keys(committed.state.accesses))
						assert.isTrue(
							key._tag === "Generation"
								? generation(done, key.id).instance === "b"
								: HashSet.has(change(done, "B").plan.writes, key),
						)
					return [count(admitted.state), count(committed.state)]
				})
				assert.deepStrictEqual(measurements, [
					[11, 13],
					[11, 13],
					[11, 13],
				])
			}),
	)

	it.effect(
		"rejects stale plans including optional absence and absence ABA",
		() =>
			Effect.sync(() => {
				const base = fixture()
				const initial = {
					...base,
					cells: HashMap.set(base.cells, slot("b"), {
						version: 0,
						value: Option.none<string>(),
					}),
				}
				const a = plan(initial, "A", [
					{ id: "a", dependencies: [{ provider: "b", optional: true }] },
				])
				const held = run(initial, [Action.Submit({ plan: a })])
				assert.strictEqual(
					stepChecked(
						held,
						Action.Submit({ plan: plan(initial, "B", [{ id: "b" }]) }),
					).decision,
					"Busy",
				)
				const b = run(
					initial,
					accepting(plan(initial, "B", [{ id: "b" }]), "b"),
				)
				assert.strictEqual(
					stepChecked(b, Action.Submit({ plan: a })).decision,
					"Stale",
				)
				const withdrawn = run(b, [
					Action.Invalidate({ object: slot("b"), cause: "Provider failed" }),
				])
				assert.isTrue(Option.isNone(cell(withdrawn, slot("b")).value))
				assert.strictEqual(cell(withdrawn, slot("b")).version, 2)
				assert.strictEqual(
					stepChecked(withdrawn, Action.Submit({ plan: a })).decision,
					"Stale",
				)
			}),
	)

	it.effect("allows shared read premises while fencing their writer", () =>
		Effect.sync(() => {
			const initial = fixture()
			const deps = [{ provider: "c", optional: false }]
			const a = plan(initial, "A", [{ id: "a", dependencies: deps }])
			const b = plan(initial, "B", [{ id: "b", dependencies: deps }])
			const state = run(initial, [
				Action.Submit({ plan: a }),
				Action.Submit({ plan: b }),
			])
			assert.strictEqual(HashMap.size(state.changes), 2)
			const writer = stepChecked(
				state,
				Action.Submit({ plan: plan(initial, "C", [{ id: "c" }]) }),
			)
			assert.strictEqual(writer.decision, "Busy")
			assert.isTrue(HashSet.has(writer.conflicts, slot("c")))
		}),
	)

	it.effect(
		"rejects acknowledgements with stale change generation or view identity",
		() =>
			Effect.sync(() => {
				const initial = ready(fixture(), "A", "a")
				for (const bad of [
					token("missing", "a"),
					token("A", "a", 0),
					token("A", "a", 1, 0),
					token("A", "b"),
				]) {
					assert.strictEqual(
						stepChecked(initial, Action.Acknowledge({ token: bad })).decision,
						"RejectedAck",
					)
				}
				const cancelled = run(initial, [Action.Cancel({ change: "A" })])
				assert.strictEqual(
					stepChecked(cancelled, Action.Acknowledge({ token: token("A", "a") }))
						.decision,
					"RejectedAck",
				)
				const switched = run(initial, [
					Action.Commit({ change: "A" }),
					Action.Cancel({ change: "A" }),
					...exit("a#0"),
					...exit("a#1"),
					Action.Recover({ change: "A", allowed: true }),
					Action.Install({ change: "A" }),
				])
				assert.strictEqual(
					stepChecked(switched, Action.Acknowledge({ token: token("A", "a") }))
						.decision,
					"RejectedAck",
				)
				assert.strictEqual(
					stepChecked(switched, Action.Commit({ change: "A" })).decision,
					"Blocked",
				)
			}),
	)

	it.effect(
		"keeps generations resolution leases and publication cleanup independent",
		() =>
			Effect.sync(() => {
				const specs = [
					{ id: "p" },
					{ id: "a", dependencies: [{ provider: "p", optional: false }] },
				]
				const initial = fixture(specs)
				let s = run(initial, [
					Action.Submit({
						plan: plan(initial, "A", [Arr.getUnsafe(specs, 1)]),
					}),
					Action.Prepare({ change: "A" }),
					...activate("A", "a"),
				])
				assert.strictEqual(
					HashSet.size(Option.getOrThrow(HashMap.get(s.leaseHolders, "p#0"))),
					2,
				)
				s = run(s, [
					Action.ReleaseLease({ consumer: "a#0", provider: "p#0" }),
					...exit("a#0"),
					Action.Finish({ change: "A" }),
				])
				assert.strictEqual(Option.getOrThrow(cell(s, slot("a")).value), "a#1")
				assert.isFalse(HashSet.has(s.unavailable, slot("a")))
				assert.isTrue(HashSet.has(generation(s, "a#1").leases, "p#0"))
				const replacement = plan(s, "B", specs, "Restart")
				s = run(s, [
					Action.Submit({ plan: replacement }),
					Action.Prepare({ change: "B" }),
					Action.StopOld({ change: "B" }),
					Action.Evidence({ generation: "p#0", evidence: "Exited" }),
				])
				assert.strictEqual(
					stepChecked(s, Action.Retire({ generation: "p#0" })).decision,
					"Blocked",
				)
				s = run(s, [Action.ReleaseLease({ consumer: "a#0", provider: "p#0" })])
				assert.strictEqual(
					stepChecked(s, Action.Retire({ generation: "p#0" })).decision,
					"Blocked",
				)
				assert.strictEqual(
					HashMap.getUnsafe(generation(s, "a#1").resolution, slot("p")),
					"p#0",
				)
				assert.strictEqual(
					HashMap.getUnsafe(generation(s, "a#2").resolution, slot("p")),
					"p#1",
				)
				s = run(s, [
					Action.ReleaseLease({ consumer: "a#1", provider: "p#0" }),
					Action.Retire({ generation: "p#0" }),
				])
				assert.isTrue(generation(s, "p#0").retired)
			}),
	)

	it.effect("requires deployment group and local lease consumer closure", () =>
		Effect.sync(() => {
			const grouped = fixture([
				{ id: "a", group: "shared" },
				{ id: "b", group: "shared" },
			])
			assert.strictEqual(
				step(
					grouped,
					Action.Submit({
						plan: plan(grouped, "A", [{ id: "a", group: "shared" }]),
					}),
				).decision,
				"InvalidPlan",
			)
			const local = fixture([
				{ id: "a", dependencies: [{ provider: "b", optional: false }] },
				{ id: "b" },
			])
			assert.strictEqual(
				step(local, Action.Submit({ plan: plan(local, "A", [{ id: "b" }]) }))
					.decision,
				"InvalidPlan",
			)
			const shared = plan(grouped, "A", [
				{ id: "a", group: "shared" },
				{ id: "b", group: "shared" },
			])
			const state = run(grouped, [
				Action.Submit({ plan: shared }),
				Action.Prepare({ change: "A" }),
				Action.Install({ change: "A" }),
				Action.Acknowledge({ token: token("A", "a") }),
			])
			assert.strictEqual(
				stepChecked(state, Action.Commit({ change: "A" })).decision,
				"Blocked",
			)
			const committed = run(state, [
				Action.Acknowledge({ token: token("A", "b") }),
				Action.Commit({ change: "A" }),
				...exit("a#0"),
			])
			assert.strictEqual(
				stepChecked(committed, Action.Finish({ change: "A" })).decision,
				"Blocked",
			)
			conclusion(
				run(committed, [...exit("b#0"), Action.Finish({ change: "A" })]),
				"A",
				"Accepted",
			)
		}),
	)

	it.effect("distinguishes equal service keys in different realms", () =>
		Effect.sync(() => {
			const initial = fixture([
				{ id: "a", realm: "east" },
				{ id: "b", realm: "west" },
			])
			const a = plan(initial, "A", [{ id: "a", realm: "east" }])
			const b = plan(initial, "B", [{ id: "b", realm: "west" }])
			const sameKey = (p: typeof a, realm: string): typeof a => {
				const key = ObjectKey.Slot({ realm, key: "service" })
				return {
					...p,
					reads: HashMap.set(p.reads, key, cell(initial, key)),
					writes: HashSet.add(p.writes, key),
					members: HashMap.map(p.members, (m) => ({
						...m,
						publications: HashSet.make(key),
					})),
				}
			}
			const state = run(initial, [
				Action.Submit({ plan: sameKey(a, "east") }),
				Action.Submit({ plan: sameKey(b, "west") }),
			])
			assert.strictEqual(HashMap.size(state.changes), 2)
		}),
	)

	it.effect(
		"does not self-preempt planned withdrawal and never swallows invalidation as Busy",
		() =>
			Effect.sync(() => {
				const initial = fixture()
				const deps = [{ provider: "b", optional: false }]
				const a = plan(initial, "A", [{ id: "a", dependencies: deps }])
				const admitted = run(initial, [
					Action.Submit({ plan: a }),
					Action.Prepare({ change: "A" }),
				])
				const planned = run(admitted, [
					Action.Withdraw({ change: "A", object: slot("a") }),
				])
				assert.strictEqual(change(planned, "A").phase, "Prepared")
				assert.isFalse(change(planned, "A").invalidated)
				const invalidated = run(planned, [
					Action.Invalidate({ object: slot("b"), cause: "Provider failed" }),
				])
				assert.isTrue(HashSet.has(invalidated.unavailable, slot("b")))
				assert.strictEqual(change(invalidated, "A").phase, "Recovering")
				assert.isTrue(change(invalidated, "A").invalidated)
				assert.strictEqual(
					stepChecked(
						invalidated,
						Action.Submit({ plan: plan(invalidated, "C", [{ id: "a" }]) }),
					).decision,
					"Busy",
				)
				const failed = run(invalidated, [
					Action.ReleaseLease({ consumer: "a#1", provider: "b#0" }),
					...exit("a#0"),
					...exit("a#1"),
					Action.Recover({ change: "A", allowed: true }),
					Action.Finish({ change: "A" }),
				])
				conclusion(failed, "A", "RecoveryFailed")
				assert.isTrue(Option.isNone(cell(failed, slot("b")).value))
			}),
	)

	it.effect(
		"enumerates invalidation cancellation acknowledgements and shutdown at every bounded position",
		() =>
			Effect.sync(() => {
				const initial = ready(ready(fixture(), "A", "a"), "B", "b")
				const states = reachable(
					initial,
					[
						Action.Commit({ change: "A" }),
						Action.Cancel({ change: "A" }),
						Action.Invalidate({ object: slot("a"), cause: "Endpoint failed" }),
						Action.Acknowledge({ token: token("A", "a") }),
						Action.Evidence({ generation: "a#1", evidence: "Exited" }),
						Action.Retire({ generation: "a#1" }),
						Action.Deadline({ change: "A" }),
						Action.Commit({ change: "B" }),
						Action.Close(),
					],
					4,
					transition,
				)
				assert.isAbove(HashSet.size(states), 100)
				assert.isTrue(
					HashSet.some(states, (s) => Option.isSome(change(s, "A").conclusion)),
				)
				for (const s of states) {
					invariant(s)
					const ended = run(s, [
						Action.Deadline({ change: "A" }),
						Action.Deadline({ change: "B" }),
					])
					assert.isTrue(Option.isSome(change(ended, "A").conclusion))
					assert.isTrue(Option.isSome(change(ended, "B").conclusion))
				}
			}),
		60000,
	)

	it.effect(
		"settles every admitted change after shutdown across all submission interleavings",
		() =>
			Effect.sync(() => {
				const initial = fixture()
				const actors = [
					[
						Action.Submit({ plan: plan(initial, "A", [{ id: "a" }]) }),
						Action.Prepare({ change: "A" }),
						...activate("A", "a"),
					],
					[
						Action.Submit({ plan: plan(initial, "B", [{ id: "b" }]) }),
						Action.Prepare({ change: "B" }),
						...activate("B", "b"),
					],
					[Action.Close()],
				]
				const stats = explore(
					{ name: "runtime shutdown", initial, actors },
					{
						transition,
						terminal: (s) => {
							const settled = settleClosed(s)
							assert.isFalse(settled.open)
							for (const id of HashMap.keys(settled.changes)) {
								const ending = facts(settled, id).outcome
								assert.isTrue(
									ending === "Aborted" || ending === "RecoveryFailed",
								)
								conclusion(settled, id, ending)
							}
							assert.strictEqual(
								stepChecked(
									settled,
									Action.Submit({ plan: plan(initial, "C", [{ id: "c" }]) }),
								).decision,
								"Closed",
							)
						},
					},
				)
				assert.strictEqual(stats.schedules, 2772)
			}),
		60000,
	)

	it.effect(
		"treats cancellation after stopping old generations as recovery before route switch",
		() =>
			Effect.sync(() => {
				const initial = fixture()
				let s = run(initial, [
					Action.Submit({ plan: plan(initial, "A", [{ id: "a" }], "Restart") }),
					Action.Prepare({ change: "A" }),
				])
				assert.strictEqual(
					stepChecked(s, Action.Install({ change: "A" })).decision,
					"Blocked",
				)
				s = run(s, [
					Action.StopOld({ change: "A" }),
					...exit("a#0"),
					Action.Cancel({ change: "A" }),
					Action.Evidence({ generation: "a#1", evidence: "NotStarted" }),
					Action.Retire({ generation: "a#1" }),
					Action.Recover({ change: "A", allowed: true }),
					...activate("A", "a", 2, 2),
					Action.Finish({ change: "A" }),
				])
				conclusion(s, "A", "Recovered")
				assert.strictEqual(generation(s, "a#2").config, "original")
			}),
	)

	it.effect(
		"refuses recovery after losing an owned version and preserves failure causes",
		() =>
			Effect.sync(() => {
				const readyState = ready(fixture(), "A", "a")
				const s = run(readyState, [
					Action.Commit({ change: "A" }),
					Action.Cancel({ change: "A" }),
					Action.Invalidate({ object: slot("a"), cause: "Publication failed" }),
					...exit("a#0"),
					...exit("a#1"),
					Action.Recover({ change: "A", allowed: true }),
					Action.Finish({ change: "A" }),
				])
				conclusion(s, "A", "RecoveryFailed")
				assert.strictEqual(cell(s, slot("a")).version, 3)
				assert.isTrue(Option.isNone(cell(s, slot("a")).value))
				assert.isAtLeast(facts(s, "A").cause.reasons.length, 3)
			}),
	)

	it.effect(
		"exposes counterexamples to snapshot replacement and fork-wide lease release",
		() =>
			Effect.sync(() => {
				const initial = fixture()
				const a = run(
					initial,
					accepting(plan(initial, "A", [{ id: "a" }]), "a"),
				)
				const b = run(
					initial,
					accepting(plan(initial, "B", [{ id: "b" }]), "b"),
				)
				// Deliberately broken snapshot replacement: B's base snapshot erases A.
				assert.isFalse(
					Equal.equals(cell(b, instance("a")), cell(a, instance("a"))),
				)
				assert.strictEqual(
					Option.getOrThrow(cell(b, instance("a")).value),
					"a#0",
				)
				const merged = run(a, accepting(plan(initial, "B", [{ id: "b" }]), "b"))
				assert.throws(() =>
					transition(
						merged,
						Action.Commit({ change: "B" }),
						{
							state: { ...merged, cells: b.cells },
							decision: "Applied",
							conflicts: HashSet.empty(),
						},
						[],
					),
				)

				const leased = fixture([
					{ id: "p" },
					{ id: "a", dependencies: [{ provider: "p", optional: false }] },
				])
				const staged = run(leased, [
					Action.Submit({
						plan: plan(leased, "A", [
							{ id: "a", dependencies: [{ provider: "p", optional: false }] },
						]),
					}),
					Action.Prepare({ change: "A" }),
				])
				const holders = Option.getOrThrow(
					HashMap.get(staged.leaseHolders, "p#0"),
				)
				assert.strictEqual(HashSet.size(holders), 2)
				const broken = HashSet.filter(
					holders,
					(id) => generation(staged, id).instance !== "a",
				)
				assert.strictEqual(HashSet.size(broken), 0)
				assert.throws(() =>
					invariant({
						...staged,
						leaseHolders: HashMap.set(staged.leaseHolders, "p#0", broken),
					}),
				)
				assert.isTrue(HashSet.has(generation(staged, "a#1").leases, "p#0"))
			}),
	)
})
