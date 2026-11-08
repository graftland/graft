import { Context, Effect } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Loader } from "../src/index.ts"
import { fixture, loaderService, run } from "./utils.ts"

class Dependency extends Context.Service<Dependency, string>()(
	"@graftland/loader/test/group-lifecycle.test/Dependency",
) {}

describe("group lifecycle", () => {
	it.effect(
		"removes a provider and its consumer without retaining a lease",
		() =>
			run({
				provider: fixture("lifecycle-provider"),
				consumer: fixture("lifecycle-consumer"),
			})((journal) =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "group",
							name: "group",
							group: true,
							config: [
								{ id: "provider", name: "provider" },
								{ id: "consumer", name: "consumer" },
							],
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					yield* loader.update("group", { config: [] })
					yield* loader.ready
					yield* journal.expect(["start consumer", "stop consumer"])
				}),
			),
	)

	it.effect(
		"keeps the injected child instance when its update handler accepts config",
		() =>
			run({ updatable: fixture("updatable") })((journal) =>
				Effect.gen(function* () {
					yield* Graft.provide(Dependency, "available")
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "entry",
							name: "updatable",
							inject: [Dependency.key],
							config: "first",
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					yield* loader.update("entry", { config: "second" })
					yield* loader.ready
					yield* journal.expect(["start first", "update second"])
					const entries = yield* loader.entries
					assert.strictEqual(entries[0]?.config, "second")
				}),
			),
	)
})
