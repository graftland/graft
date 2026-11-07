import { Array, Effect, HashMap, Option } from "effect"
import { assert, it } from "@effect/vitest"

import { make } from "./change-model/adapter.ts"
import { run as modelRun } from "./change-model/assertions.ts"
import { Action, cell, change } from "./change-model/model.ts"
import {
	accepting,
	activate,
	exit,
	fixture,
	independent,
	instance,
	plan,
	token,
} from "./change-model/scenarios.ts"
import { run } from "./utils.ts"

for (const order of ["forward", "reverse", "interleaved"]) {
	it.effect(
		`drives the phase zero independent scenario through production in ${order} order`,
		() =>
			run(
				Effect.gen(function* () {
					const scenario = independent()
					const first = Array.getUnsafe(scenario.actors, 0)
					const second = Array.getUnsafe(scenario.actors, 1)
					const schedule =
						order === "forward"
							? [...first, ...second]
							: order === "reverse"
								? [...second, ...first]
								: [...Array.take(first, 5), ...second, ...Array.drop(first, 5)]
					const expected = modelRun(scenario.initial, schedule)
					const adapter = yield* make(scenario.initial)
					yield* adapter.run(schedule)
					for (const { id, member } of [
						{ id: "A", member: "a" },
						{ id: "B", member: "b" },
					]) {
						const outcome = yield* adapter.outcome(id)
						assert.strictEqual(
							outcome._tag,
							Option.getOrThrow(change(expected, id).conclusion).outcome,
						)
						assert.strictEqual(
							outcome.members[0]?.actual.version,
							cell(expected, instance(member)).version,
						)
						const actual = yield* adapter.read(member)
						const generation = Option.getOrThrow(
							cell(expected, instance(member)).value,
						)
						assert.strictEqual(
							actual,
							HashMap.getUnsafe(expected.generations, generation).config,
						)
					}
					const capacity = yield* adapter.capacity
					assert.deepStrictEqual(
						{ used: capacity.used, reserved: capacity.reserved },
						expected.capacity,
					)
				}),
			),
	)
}

it.effect(
	"drives Stuck isolation and late reservation release through production without changing the recorded outcome",
	() =>
		run(
			Effect.gen(function* () {
				const initial = fixture()
				const a = plan(initial, "A", [{ id: "a" }])
				const stuckActions = [
					Action.Submit({ plan: a }),
					Action.Prepare({ change: "A" }),
					...activate("A", "a"),
					Action.Deadline({ change: "A" }),
				]
				const stuckModel = modelRun(initial, stuckActions)
				const adapter = yield* make(initial)
				yield* adapter.run(stuckActions)
				const stuck = yield* adapter.outcome("A")
				assert.strictEqual(
					stuck._tag,
					Option.getOrThrow(change(stuckModel, "A").conclusion).outcome,
				)
				const conflict = yield* Effect.flip(
					adapter.run([
						Action.Submit({ plan: plan(stuckModel, "C", [{ id: "a" }]) }),
					]),
				)
				assert.strictEqual(conflict._tag, "ChangeRejected")
				if (conflict._tag === "ChangeRejected")
					assert.strictEqual(conflict.reason._tag, "Busy")
				const independentActions = accepting(
					plan(stuckModel, "B", [{ id: "b" }]),
					"b",
				)
				yield* adapter.run(independentActions)
				assert.strictEqual((yield* adapter.outcome("B"))._tag, "Accepted")
				const release = [
					...exit("a#0"),
					...exit("a#1"),
					Action.ReleaseReservations({ change: "A" }),
				]
				yield* adapter.run(release)
				const repeated = yield* adapter.outcome("A")
				assert.deepStrictEqual(repeated, stuck)
				const settledModel = modelRun(
					modelRun(stuckModel, independentActions),
					release,
				)
				const fresh = accepting(
					plan(settledModel, "D", [{ id: "a" }], "Restart"),
					"a",
				)
				// A fresh change has its own generation; the old Stuck watcher cannot release its reservation.
				yield* adapter.run(Array.take(fresh, 1))
				const activeConflict = yield* Effect.flip(
					adapter.run([
						Action.Submit({ plan: plan(settledModel, "E", [{ id: "a" }]) }),
					]),
				)
				assert.strictEqual(activeConflict._tag, "ChangeRejected")
				yield* adapter.run([
					Action.Prepare({ change: "D" }),
					Action.Install({ change: "D" }),
					Action.Acknowledge({ token: token("D", "a", 2) }),
					Action.Commit({ change: "D" }),
					Action.Finish({ change: "D" }),
				])
				assert.strictEqual((yield* adapter.outcome("D"))._tag, "Accepted")
			}),
		),
)
