import { Effect, Option } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Entry, Loader } from "../src/index.ts"
import { loaderService, run, type Journal } from "./utils.ts"

const reporter = (journal: Journal) =>
	Plugin.make({
		name: "reporter",
		apply: () =>
			Effect.gen(function* () {
				const id = yield* Entry.CurrentId
				yield* journal.record(Option.getOrElse(id, () => "none"))
			}),
	})

it.effect("tells each plugin the id of the entry it was loaded from", () =>
	run((journal) => ({ reporter: reporter(journal) }))((journal) =>
		Effect.gen(function* () {
			yield* Graft.plugin(Loader.plugin, [
				{ id: "top", name: "reporter" },
				{
					id: "outer",
					name: "group",
					group: true,
					config: [{ id: "nested", name: "reporter" }],
				},
			])
			const loader = yield* loaderService
			yield* loader.ready
			yield* journal.expect(["top", "nested"])
		}),
	),
)

it.effect("has no entry id outside the loader", () =>
	Effect.gen(function* () {
		const id = yield* Entry.CurrentId
		assert.isTrue(Option.isNone(id))
	}),
)
