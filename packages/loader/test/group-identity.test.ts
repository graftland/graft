import { Array, Cause, Effect, Exit, Option, Schema, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, type Fork } from "@graftland/graft"

import { Group } from "../src/index.ts"
import { run } from "./utils.ts"

const flatten = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<Fork.ForkTree> =>
	Array.flatMap(trees, (tree) => [tree, ...flatten(tree.children)])
const settled = (id: number) =>
	Graft.forks.pipe(
		Stream.map((trees) =>
			Array.findFirst(flatten(trees), (tree) => tree.id === id),
		),
		Stream.filter((tree) =>
			Option.exists(tree, (tree) =>
				Array.every(flatten([tree]), (node) => node.state._tag !== "Loading"),
			),
		),
		Stream.map(Option.getOrThrow),
		Stream.runHead,
		Effect.map(Option.getOrThrow),
	)

it.effect("rejects duplicate sibling IDs at the public Group boundary", () =>
	run()(() =>
		Effect.gen(function* () {
			const group = yield* Graft.plugin(Group.Group, [
				{ id: "duplicate", name: "echo", config: { text: "first" } },
				{ id: "duplicate", name: "echo", config: { text: "second" } },
			])
			const result = yield* Effect.exit(group.await)
			assert(
				Exit.isFailure(result),
				"Duplicate IDs must not silently collapse two entries into one",
			)
		}),
	),
)

it.effect(
	"rejects duplicate IDs on update before starting conflicting children and recovers",
	() =>
		run()((journal) =>
			Effect.gen(function* () {
				const group = yield* Graft.plugin(Group.Group, [])
				yield* group.await
				yield* group.update([
					{ id: "duplicate", name: "echo", config: { text: "first" } },
					{ id: "duplicate", name: "echo", config: { text: "second" } },
				])
				const failed = yield* Effect.exit(group.await)
				assert(Exit.isFailure(failed))
				const error = Option.getOrThrow(Cause.findErrorOption(failed.cause))
				assert(Schema.isSchemaError(error))
				assert.include(error.message, 'Duplicate entry id "duplicate"')
				yield* journal.expect([])
				yield* group.update([
					{ id: "unique", name: "echo", config: { text: "recovered" } },
				])
				yield* group.await
				yield* settled(group.id)
				yield* journal.expect(["start recovered"])
			}),
		),
)

it.effect(
	"checks disabled IDs too without rejecting healthy siblings of an invalid nested group",
	() =>
		run()((journal) =>
			Effect.gen(function* () {
				const group = yield* Graft.plugin(Group.Group, [
					{
						id: "bad",
						name: "group",
						group: true,
						config: [
							{ id: "duplicate", name: "echo", config: { text: "blocked" } },
							{ id: "duplicate", name: "echo", disabled: true },
						],
					},
					{ id: "healthy", name: "echo", config: { text: "healthy" } },
				])
				yield* group.await
				const tree = yield* settled(group.id)
				assert.strictEqual(tree.state._tag, "Active")
				assert.deepStrictEqual(
					Array.map(tree.children, (child) => child.state._tag),
					["Failed", "Active"],
				)
				yield* journal.expect(["start healthy"])
				const invalid = yield* Graft.plugin(Group.Group, [
					{ id: "duplicate", name: "echo", disabled: true },
					{ id: "duplicate", name: "echo", disabled: true },
				])
				const failed = yield* Effect.exit(invalid.await)
				assert(Exit.isFailure(failed))
			}),
		),
)

it.effect(
	"captures direct Group inputs before retaining them for reconciliation",
	() =>
		run()((journal) =>
			Effect.gen(function* () {
				const config = { text: "before" }
				const entries = [{ id: "entry", name: "echo", config }]
				const group = yield* Graft.plugin(Group.Group, entries)
				yield* group.await
				yield* settled(group.id)
				config.text = "after"
				yield* group.update(entries)
				yield* settled(group.id)
				yield* journal.expect(["start before", "stop before", "start after"])
			}),
		),
)
