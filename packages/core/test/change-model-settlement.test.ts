import { Effect, Equal, HashMap, HashSet, Option } from "effect"
import { assert, it } from "@effect/vitest"

import { run, stepChecked } from "./change-model/assertions.ts"
import {
	Action,
	cell,
	change,
	generation,
	ObjectKey,
	step,
} from "./change-model/model.ts"
import {
	accepting,
	activate,
	exit,
	fixture,
	instance,
	plan,
} from "./change-model/scenarios.ts"

it.effect(
	"releases Stuck reservations after late settlement without changing the outcome",
	() =>
		Effect.sync(() => {
			const initial = fixture()
			const stuck = run(initial, [
				Action.Submit({ plan: plan(initial, "A", [{ id: "a" }]) }),
				Action.Prepare({ change: "A" }),
				...activate("A", "a"),
				Action.Deadline({ change: "A" }),
			])
			const outcome = change(stuck, "A").conclusion
			assert.strictEqual(
				stepChecked(stuck, Action.ReleaseReservations({ change: "A" }))
					.decision,
				"Blocked",
			)
			const released = run(stuck, [
				...exit("a#0"),
				Action.ReleaseReservations({ change: "A" }),
				Action.ReleaseReservations({ change: "A" }),
			])
			assert.isTrue(Equal.equals(outcome, change(released, "A").conclusion))
			assert.isTrue(
				Option.isNone(
					HashMap.getUnsafe(released.reservations, instance("a")).writer,
				),
			)
			assert.strictEqual(
				stepChecked(
					released,
					Action.Submit({ plan: plan(released, "B", [{ id: "a" }]) }),
				).decision,
				"Applied",
			)
		}),
)

it.effect(
	"keeps cleanup evidence monotonic when exit evidence is repeated",
	() =>
		Effect.sync(() => {
			const initial = fixture()
			const completed = run(initial, [
				Action.Submit({ plan: plan(initial, "A", [{ id: "a" }]) }),
				Action.Prepare({ change: "A" }),
				...activate("A", "a"),
				Action.Evidence({
					generation: "a#0",
					evidence: "Exited",
					cleanup: "Completed",
				}),
				Action.Evidence({ generation: "a#0", evidence: "Exited" }),
			])
			assert.strictEqual(generation(completed, "a#0").cleanup, "Completed")
		}),
)

it.effect(
	"detects absence presence absence with a monotonically increasing object version",
	() =>
		Effect.sync(() => {
			const initial = fixture()
			const key = ObjectKey.Slot({ realm: "", key: "optional" })
			const a = plan(initial, "A", [{ id: "a" }])
			const stale = {
				...a,
				reads: HashMap.set(a.reads, key, cell(initial, key)),
			}
			const b = plan(initial, "B", [{ id: "b" }])
			const publisher = {
				...b,
				reads: HashMap.set(b.reads, key, cell(initial, key)),
				writes: HashSet.add(b.writes, key),
				members: HashMap.map(b.members, (m) => ({
					...m,
					publications: HashSet.add(m.publications, key),
				})),
			}
			const present = run(initial, accepting(publisher, "b"))
			assert.isTrue(Option.isSome(cell(present, key).value))
			const absent = run(present, [
				Action.Invalidate({ object: key, cause: "Optional service withdrawn" }),
			])
			assert.isTrue(Option.isNone(cell(absent, key).value))
			assert.strictEqual(cell(absent, key).version, 2)
			assert.strictEqual(
				step(absent, Action.Submit({ plan: stale })).decision,
				"Stale",
			)
		}),
)

it.effect(
	"reserves Restart capacity through old exit and recovery at the unit limit",
	() =>
		Effect.sync(() => {
			const base = fixture([{ id: "a" }])
			const initial = { ...base, maxUnits: 1 }
			assert.strictEqual(
				step(
					initial,
					Action.Submit({ plan: plan(initial, "overlap", [{ id: "a" }]) }),
				).decision,
				"Capacity",
			)
			const restarted = run(initial, [
				Action.Submit({ plan: plan(initial, "A", [{ id: "a" }], "Restart") }),
				Action.Prepare({ change: "A" }),
				Action.StopOld({ change: "A" }),
				...exit("a#0"),
				...activate("A", "a"),
				Action.Cancel({ change: "A" }),
				...exit("a#1"),
				Action.Recover({ change: "A", allowed: true }),
				...activate("A", "a", 2, 2),
				Action.Finish({ change: "A" }),
			])
			assert.strictEqual(
				Option.getOrThrow(change(restarted, "A").conclusion).outcome,
				"Recovered",
			)
			assert.strictEqual(HashSet.size(generation(restarted, "a#2").leases), 0)
		}),
)
