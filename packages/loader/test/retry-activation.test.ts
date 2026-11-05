import {
	Array,
	Context,
	Deferred,
	Effect,
	Layer,
	Path,
	Ref,
	Schema,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Loader, ModuleResolver } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

class Gate extends Context.Service<Gate, string>()(
	"@graftland/loader/test/retry-activation.test/Gate",
) {}

it.effect.each(["direct", "injected", "nested", "injected group"])(
	"retries failed activation through a %s entry without restarting healthy siblings",
	(kind) =>
		Effect.gen(function* () {
			const available = yield* Ref.make(false)
			const attempts = yield* Ref.make(0)
			const healthyStarts = yield* Ref.make(0)
			const healthyUpdates = yield* Ref.make(0)
			const flaky = Plugin.make({
				name: "flaky",
				apply: () =>
					Effect.gen(function* () {
						yield* Ref.update(attempts, (n) => n + 1)
						if (!(yield* Ref.get(available)))
							return yield* Effect.fail("Temporarily unavailable")
					}),
			})
			const healthy = Plugin.make({
				name: "healthy",
				config: Schema.Unknown,
				apply: () =>
					Ref.update(healthyStarts, (n) => n + 1).pipe(
						Effect.as((_next: unknown) =>
							Ref.update(healthyUpdates, (n) => n + 1).pipe(Effect.as(true)),
						),
					),
			})
			yield* run(() => ({ flaky, healthy }))(() =>
				Effect.gen(function* () {
					yield* Graft.provide(Gate, "available")
					const entries = [
						{
							id: "flaky",
							name: "flaky",
							...(kind === "injected" ? { inject: [Gate.key] } : {}),
						},
						{ id: "healthy", name: "healthy" },
					]
					yield* Graft.plugin(
						Loader.plugin,
						kind === "nested" || kind === "injected group"
							? [
									{
										id: "group",
										name: "group",
										group: true,
										config: entries,
										...(kind === "injected group"
											? { inject: [Gate.key] }
											: {}),
									},
								]
							: entries,
					)
					const loader = yield* loaderService
					yield* loader.ready
					const first = yield* Ref.get(attempts)
					assert.strictEqual(first, 1)
					yield* Ref.set(available, true)
					yield* loader.retry
					yield* loader.ready
					yield* loader.retry
					yield* loader.ready
					const retried = yield* Ref.get(attempts)
					const starts = yield* Ref.get(healthyStarts)
					const updates = yield* Ref.get(healthyUpdates)
					assert.strictEqual(retried, 2)
					assert.strictEqual(starts, 1)
					assert.strictEqual(updates, 0)
				}),
			)
		}),
)

it.effect(
	"retries failed resolution while retaining unfinished resolution",
	() =>
		Effect.gen(function* () {
			const available = yield* Ref.make(false)
			const attempts = yield* Ref.make(0)
			const slowAttempts = yield* Ref.make(0)
			const slowStarted = yield* Deferred.make<void>()
			const started = yield* Deferred.make<void>()
			const plugin = Plugin.make({
				name: "recovered",
				apply: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
			})
			const resolver = ModuleResolver.layer({
				base: "/app",
				importer: (name) =>
					name === "slow"
						? Ref.update(slowAttempts, (n) => n + 1).pipe(
								Effect.andThen(Deferred.succeed(slowStarted, undefined)),
								Effect.andThen(Effect.never),
							)
						: Effect.gen(function* () {
								yield* Ref.update(attempts, (n) => n + 1)
								if (!(yield* Ref.get(available)))
									return yield* Effect.fail("Import temporarily unavailable")
								return { default: plugin }
							}),
			}).pipe(Layer.provide(Path.layer))
			yield* Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [{ id: "flaky", name: "flaky" }])
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.create({ id: "slow", name: "slow" })
				yield* Deferred.await(slowStarted)
				// A sibling beginning its import does not imply that the failed
				// entry's concurrent retry has settled.
				yield* Graft.forks.pipe(
					Stream.filterEffect((trees) =>
						Effect.map(Ref.get(attempts), (attempts) => {
							const failed = (nodes: typeof trees): boolean =>
								Array.some(
									nodes,
									(node) =>
										(node.name === "flaky" && node.state._tag === "Failed") ||
										failed(node.children),
								)
							return attempts === 2 && failed(trees)
						}),
					),
					Stream.runHead,
				)
				yield* Ref.set(available, true)
				yield* loader.retry
				yield* Deferred.await(started)
				// Removal waits for the next target to be reconciled without blocking on slow.
				yield* loader.remove("slow")
				yield* loader.ready
				const imported = yield* Ref.get(attempts)
				const slow = yield* Ref.get(slowAttempts)
				assert.strictEqual(imported, 3)
				assert.strictEqual(slow, 1)
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, resolver)),
			)
		}),
)
