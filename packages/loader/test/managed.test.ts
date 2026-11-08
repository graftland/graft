import { Effect, Option, Ref, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin, Transition } from "@graftland/graft"

import { Loader } from "../src/index"
import { fixture, loaderService, run } from "./utils"

it.effect(
	"rejects managed-tree edits before calling a store or changing its target",
	() =>
		run({ managed: fixture("noop") })(() =>
			Effect.gen(function* () {
				const writes = yield* Ref.make(0)
				const initial = [{ id: "integration", name: "managed" }]
				yield* Graft.plugin(
					Plugin.make({
						name: "stored",
						apply: () =>
							Loader.start({
								initial,
								apply: () =>
									Ref.update(writes, (n) => n + 1).pipe(Effect.as([])),
								refresh: Effect.succeedNone,
								external: Stream.never,
							}),
					}),
				)
				const loader = yield* loaderService
				yield* loader.ready
				const update = yield* Effect.flip(
					loader.update("integration", { config: { changed: true } }),
				)
				const remove = yield* Effect.flip(loader.remove("integration"))
				const retry = yield* Effect.flip(loader.retry)
				const root = yield* Effect.flip(loader.root.update([]))
				assert.equal(update._tag, "ManagedFork")
				assert.equal(remove._tag, "ManagedFork")
				assert.equal(retry._tag, "ManagedFork")
				assert.equal(root._tag, "ManagedFork")
				const count = yield* Ref.get(writes)
				const entries = yield* loader.entries
				assert.equal(count, 0)
				assert.deepEqual(entries, initial)
			}),
		).pipe(
			Effect.provideService(Transition.UnitMember, Option.some("integration")),
		),
)
