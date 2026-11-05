import { Effect } from "effect"
import { it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Entry, Loader } from "../src/index.ts"
import { echo, loaderService, run } from "./utils.ts"

for (const disabled of [true, false]) {
	it.effect(
		`keeps missing environment values local to a ${disabled ? "disabled" : "failed"} child on load and update`,
		() =>
			run((journal) => ({ echo: echo(journal) }))((journal) =>
				Effect.gen(function* () {
					const children = (text: string) => [
						{
							id: "unavailable",
							name: "echo",
							disabled,
							config: { text: new Entry.Env({ name: "MISSING" }) },
						},
						{ id: "healthy", name: "echo", config: { text } },
					]
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "outer",
							name: "group",
							group: true,
							config: [
								{
									id: "inner",
									name: "group",
									group: true,
									config: children("healthy"),
								},
							],
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					yield* journal.expect(["start healthy"])
					yield* loader.update("inner", { config: children("updated") })
					yield* loader.ready
					yield* journal.expect([
						"start healthy",
						"stop healthy",
						"start updated",
					])
				}),
			),
	)
}
