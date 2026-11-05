import { Effect, Option, Result } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Loader, Tree } from "../src/index.ts"
import { run } from "./utils.ts"

describe("tree edit validation", () => {
	it.effect("rejects duplicate initial ids before starting children", () =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(Loader.plugin, [
					{ id: "duplicate", name: "first" },
					{ id: "duplicate", name: "second" },
				])
				const error = yield* Effect.flip(fork.await)
				assert.strictEqual(error._tag, "InvalidOperation")
			}),
		),
	)
	it("rejects children of ordinary entries without replacing their config", () => {
		const entries = [
			{ id: "parent", name: "plugin", config: { token: "keep" } },
		]
		const result = Tree.apply(
			entries,
			Tree.Op.Create({
				entry: { id: "child", name: "plugin" },
				parent: Option.some("parent"),
				position: Option.none(),
			}),
		)
		assert.isTrue(Result.isFailure(result))
		assert.deepStrictEqual(entries[0]?.config, { token: "keep" })
	})

	it("rejects ids already used in another group", () => {
		const result = Tree.apply(
			[
				{
					id: "group",
					name: "group",
					group: true,
					config: [{ id: "used", name: "plugin" }],
				},
			],
			Tree.Op.Create({
				entry: { id: "used", name: "plugin" },
				parent: Option.none(),
				position: Option.none(),
			}),
		)
		assert.isTrue(Result.isFailure(result))
	})

	it("rejects duplicate ids introduced by replacing a group's config", () => {
		const result = Tree.apply(
			[
				{ id: "used", name: "plugin" },
				{ id: "group", name: "group", group: true },
			],
			Tree.Op.Update({
				id: "group",
				patch: { config: [{ id: "used", name: "plugin" }] },
			}),
		)
		assert.isTrue(Result.isFailure(result))
	})

	for (const position of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		it(`rejects invalid insertion position ${position}`, () => {
			assert.isTrue(
				Result.isFailure(
					Tree.apply(
						[],
						Tree.Op.Create({
							entry: { id: "new", name: "plugin" },
							parent: Option.none(),
							position: Option.some(position),
						}),
					),
				),
			)
		})
	}
})
