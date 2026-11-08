import { Context, Effect, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Loader } from "../src/index.ts"
import { fixture, loaderService, run } from "./utils.ts"

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

			yield* run({
				flaky: fixture("retry-activation-flaky-1330"),
				healthy: fixture("retry-activation-healthy-1330"),
			})(() =>
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
			).pipe(
				Effect.provideService(
					Context.Service<{
						readonly attempts: typeof attempts
						readonly available: typeof available
					}>("loader/fixture/retry-activation-flaky-1330"),
					{ attempts, available },
				),
				Effect.provideService(
					Context.Service<{
						readonly healthyStarts: typeof healthyStarts
						readonly healthyUpdates: typeof healthyUpdates
					}>("loader/fixture/retry-activation-healthy-1330"),
					{ healthyStarts, healthyUpdates },
				),
			)
		}),
)
