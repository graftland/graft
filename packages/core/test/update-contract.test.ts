import { assert, it } from "@effect/vitest"
import { Array, Deferred, Effect, Fiber, Ref, Schema } from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { makeJournal, run } from "./utils.ts"

it.effect("coalesces concurrent requests to the latest configuration", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<ReadonlyArray<string>>([])
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "coalesced updates",
				config: Schema.String,
				apply: () =>
					Effect.succeed((next: string) =>
						Ref.update(seen, Array.append(next)).pipe(Effect.as(true)),
					),
			}),
			"initial",
		)
		yield* fork.await
		yield* Effect.all([fork.update("first"), fork.update("second")], {
			concurrency: "unbounded",
		})
		const values = yield* Ref.get(seen)
		assert.deepStrictEqual(values, ["second"])
	}).pipe(run),
)

it.effect(
	"settles superseded requests before the latest configuration has been applied",
	() =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const entered = yield* Deferred.make<void>()
			const cleaning = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "superseded requests",
					config: Schema.String,
					apply: (input) =>
						Effect.gen(function* () {
							yield* journal.record(`apply ${input}`)
							return (next: string) =>
								journal
									.record(`update ${next}`)
									.pipe(
										Effect.andThen(Deferred.succeed(entered, undefined)),
										Effect.andThen(Effect.never),
										Effect.ensuring(
											Deferred.succeed(cleaning, undefined).pipe(
												Effect.andThen(Deferred.await(release)),
											),
										),
									)
						}),
				}),
				"initial",
			)
			yield* fork.await
			const first = yield* Effect.forkScoped(fork.update("first"))
			yield* Deferred.await(entered)
			const second = yield* Effect.forkScoped(fork.update("second"))
			yield* Deferred.await(cleaning)
			const third = yield* Effect.forkScoped(fork.update("third"))
			yield* Fiber.join(first)
			yield* Fiber.join(second)
			yield* journal.expect(["apply initial", "update first"])
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(third)
			yield* fork.await
			yield* journal.expect(["apply initial", "update first", "apply third"])
		}).pipe(run),
)
