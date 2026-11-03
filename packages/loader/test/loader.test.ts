import { describe, it } from "@effect/vitest"
import { Graft } from "@nmnmcc/graft"
import { Effect } from "effect"
import { Loader } from "../src/index.ts"
import { echo, loaderService, run } from "./utils.ts"

describe("loader", () => {
	it.effect("reconciles the running tree with every edit", () =>
		run((journal) => ({ echo: echo(journal) }))((journal) =>
			Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{ id: "a", name: "echo", config: { text: "a" } },
					{
						id: "g",
						name: "group",
						group: true,
						config: [{ id: "b", name: "echo", config: { text: "b" } }],
					},
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* journal.expect(["start a", "start b"])

				yield* loader.update("b", { config: { text: "b2" } })
				yield* loader.ready
				yield* loader.create(
					{ name: "echo", config: { text: "c" } },
					{ parent: "g", position: 0 },
				)
				yield* loader.ready
				yield* loader.update("a", { disabled: true })
				yield* loader.ready
				yield* loader.remove("g")
				yield* loader.ready
				yield* journal.expect([
					"start a",
					"start b",
					"stop b",
					"start b2",
					"start c",
					"stop a",
					"stop c",
					"stop b2",
				])
			}),
		),
	)

	it.effect(
		"keeps an entry whose plugin cannot be found as a failed fork",
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{ id: "missing", name: "nowhere" },
					])
					const loader = yield* loaderService
					yield* loader.ready
					const error = yield* Effect.flip(
						loader.update("other", { disabled: true }),
					)
					if (error._tag !== "EntryNotFound")
						throw new Error("expected EntryNotFound")
				}),
			),
	)
})
