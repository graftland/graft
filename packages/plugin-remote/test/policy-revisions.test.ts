import { Array, Effect, HashMap, Option, Schema, String, TxRef } from "effect"
import { assert, it } from "@effect/vitest"

import { Trust } from "@graftland/graft"

import {
	approve,
	bind,
	comparison,
	initial,
	publish,
	review,
	Store,
	type State,
} from "../src/internal/policy"

const identity = {
	package: "@example/forecast",
	digest: String.repeat(64)("a"),
}
const other = { package: "@example/other", digest: String.repeat(64)("b") }
const publication: Trust.Publication = {
	projection: "mcp/tools",
	view: "forecasts",
	values: [
		{ service: "forecast", operation: "read@1", value: { title: "Forecast" } },
	],
}

it.effect(
	"retains per-entry authorization revisions through projection ABA and duplicate bindings",
	() =>
		Effect.gen(function* () {
			const state = yield* TxRef.make<State>(
				initial({
					version: "1",
					entries: [
						{
							entry: "forecast",
							artifact: identity,
							tier: "trusted",
							grants: [],
						},
						{ entry: "other", artifact: other, tier: "trusted", grants: [] },
					],
				}),
			)
			yield* Effect.gen(function* () {
				yield* bind("forecast", "a", identity, ["forecast"])
				yield* bind("other", "b", other, ["other"])
				yield* publish(publication, Option.none())
				const first = yield* comparison("forecast", "a")
				yield* Effect.scoped(bind("forecast", "a", identity, ["forecast"]))
				const duplicate = yield* comparison("forecast", "a")
				assert.equal(duplicate.revision, first.revision)
				const expected = first.current
				const record = yield* review({
					expected,
					who: "operator",
				}).pipe(Effect.catchTag("Unapproved", Effect.die))
				yield* approve(record)
				const before = yield* comparison("forecast", "a")
				const unrelated = yield* comparison("other", "b")
				yield* publish({ ...publication, values: [] }, Option.none())
				yield* publish(publication, Option.none())
				const after = yield* comparison("forecast", "a")
				const stillUnrelated = yield* comparison("other", "b")
				assert.isTrue(
					Schema.toEquivalence(Schema.Json)(after.current, before.current),
				)
				assert.isAbove(after.revision, before.revision)
				assert.equal(stillUnrelated.revision, unrelated.revision)
			}).pipe(Effect.provideService(Store, state))
		}).pipe(Effect.scoped),
)

it.effect("admission and binding do not inspect unrelated policy entries", () =>
	Effect.gen(function* () {
		const unrelated = Array.makeBy(100, (index) => `unrelated-${index}`)
		const state = yield* TxRef.make(
			initial({
				version: "1",
				entries: [
					{
						entry: "forecast",
						artifact: identity,
						tier: "trusted",
						grants: [],
					},
					...Array.map(unrelated, (entry) => ({
						entry,
						artifact: identity,
						tier: "trusted" as const,
						grants: [],
					})),
				],
			}),
		)
		let reads = 0
		const instrument = <A>(index: HashMap.HashMap<string, ReadonlyArray<A>>) =>
			HashMap.map(index, (values, entry) =>
				entry === "forecast"
					? values
					: new Proxy(values, {
							get: (target, key, receiver) => {
								reads++
								return Reflect.get(target, key, receiver)
							},
						}),
			)
		yield* Effect.gen(function* () {
			yield* Effect.forEach(unrelated, (entry) =>
				bind(entry, entry, identity, [entry]),
			)
			yield* TxRef.update(state, (current) => ({
				...current,
				assignments: instrument(current.assignments),
				bindings: instrument(current.bindings),
				declarations: instrument(current.declarations),
				approvals: instrument(current.approvals),
			}))
			yield* bind("forecast", "candidate", identity, ["forecast"])
			yield* comparison("forecast", "candidate")
			assert.equal(reads, 0)
		}).pipe(Effect.provideService(Store, state))
	}).pipe(Effect.scoped),
)
