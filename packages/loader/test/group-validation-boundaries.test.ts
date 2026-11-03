import { assert, it } from "@effect/vitest"
import { Graft, type Fork } from "@graftland/graft"
import { Effect, Array, Stream, Result, Option, Cause, Schema } from "effect"
import { Group, Tree, type Entry } from "../src/index.ts"
import { echo, run } from "./utils.ts"
const flatten = (
	nodes: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<Fork.ForkTree> =>
	Array.flatMap(nodes, (node) => [node, ...flatten(node.children)])
const settled = Graft.forks.pipe(
	Stream.filter((trees) =>
		Array.every(flatten(trees), (node) => node.state._tag !== "Loading"),
	),
	Stream.runHead,
	Effect.map(Option.getOrThrow),
)
const wrap = (
	depth: number,
	entries: ReadonlyArray<Entry.Entry>,
): ReadonlyArray<Entry.Entry> =>
	depth === 0
		? entries
		: [
				{
					id: `wrapper-${depth}`,
					name: "group",
					group: true,
					config: wrap(depth - 1, entries),
				},
			]

it.effect.each([0, 1, 3])(
	"keeps Group IDs local at depth %s on load and update",
	(depth) =>
		run((journal) => ({ echo: echo(journal) }))((journal) =>
			Effect.gen(function* () {
				const branches = (right: string) =>
					Array.map(["left", "right"], (side) => ({
						id: side,
						name: "group",
						group: true,
						config: [
							{
								id: "shared",
								name: "echo",
								config: { text: side === "right" ? right : side },
							},
						],
					}))
				const initial = wrap(depth, branches("right"))
				assert(
					Result.isFailure(Tree.validate(initial)),
					"Loader targets still require global IDs",
				)
				const root = yield* Graft.plugin(Group.Group, initial)
				yield* root.await
				yield* settled
				yield* journal.expect(["start left", "start right"])
				yield* root.update(wrap(depth, branches("updated")))
				yield* settled
				yield* journal.expect([
					"start left",
					"start right",
					"stop right",
					"start updated",
				])
			}),
		),
)

it.effect(
	"isolates a malformed descendant group and accepts its later repair",
	() =>
		run((journal) => ({ echo: echo(journal) }))((journal) =>
			Effect.gen(function* () {
				const children = (duplicate: boolean) =>
					wrap(1, [
						{
							id: "bad",
							name: "group",
							group: true,
							config: duplicate
								? [
										{ id: "same", name: "echo" },
										{ id: "same", name: "echo" },
									]
								: [{ id: "same", name: "echo", config: { text: "repaired" } }],
						},
						{ id: "healthy", name: "echo", config: { text: "healthy" } },
					])
				const root = yield* Graft.plugin(Group.Group, children(true))
				yield* root.await
				const trees = yield* settled
				assert(
					Array.some(flatten(trees), (node) => node.state._tag === "Failed"),
				)
				yield* journal.expect(["start healthy"])
				yield* root.update(children(false))
				yield* settled
				yield* journal.expect(["start healthy", "start repaired"])
			}),
		),
)

it.effect(
	"rejects cyclic group topology without blocking a healthy sibling",
	() =>
		run((journal) => ({ echo: echo(journal) }))((journal) =>
			Effect.gen(function* () {
				const cyclic: {
					id: string
					name: string
					group: boolean
					config?: ReadonlyArray<unknown>
				} = { id: "cycle", name: "group", group: true }
				cyclic.config = [cyclic]
				const root = yield* Graft.plugin(Group.Group, [
					cyclic,
					{ id: "healthy", name: "echo", config: { text: "healthy" } },
				])
				yield* root.await
				const trees = yield* settled
				const failed = Array.findFirst(
					flatten(trees),
					(node) => node.state._tag === "Failed",
				)
				assert(Option.isSome(failed))
				assert(failed.value.state._tag === "Failed")
				const error = Option.getOrThrow(
					Cause.findErrorOption(failed.value.state.cause),
				)
				assert(Schema.is(Tree.InvalidOperation)(error))
				assert.include(error.reason, "cycle")
				yield* journal.expect(["start healthy"])
			}),
		),
)
