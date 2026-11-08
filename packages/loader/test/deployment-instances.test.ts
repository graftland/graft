import { Array, Effect } from "effect"
import { assert, it } from "@effect/vitest"

import { instances } from "../src/Deployment"
import type { Entry } from "../src/Entry"

const plugin = (id: string, fields: Partial<Entry> = {}): Entry =>
	({ id, name: "./plugin.mjs", ...fields }) as Entry
const group = (
	id: string,
	children: ReadonlyArray<Entry>,
	fields: Partial<Entry> = {},
): Entry =>
	({ id, name: "group", group: true, config: children, ...fields }) as Entry

it.effect("flattens groups into their instances in file order", () =>
	Effect.gen(function* () {
		const found = yield* instances([
			plugin("a"),
			group("g", [plugin("b"), group("h", [plugin("c")])]),
			plugin("off", { disabled: true }),
		])
		assert.deepStrictEqual(
			Array.map(found, (entry) => entry.id),
			["a", "b", "c"],
		)
	}),
)

for (const [field, value] of [
	["isolate", ["app/Key"]],
	["inject", ["app/Key"]],
	["intercept", { "app/Level": "Debug" }],
] as const)
	it.effect(`rejects ${field} on a group as well as on an entry`, () =>
		Effect.gen(function* () {
			const onGroup = yield* Effect.flip(
				instances([group("g", [plugin("b")], { [field]: value })]),
			)
			assert.deepStrictEqual([onGroup.entry, onGroup.field], ["g", field])
			const onEntry = yield* Effect.flip(
				instances([plugin("b", { [field]: value })]),
			)
			assert.deepStrictEqual([onEntry.entry, onEntry.field], ["b", field])
		}),
	)
