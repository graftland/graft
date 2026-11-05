import { Context, Effect, Layer, Path, Ref, Schema, Scope } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Loader, ModuleResolver } from "../src/index.ts"
import { loaderService } from "./utils.ts"

class Missing extends Context.Service<Missing, string>()(
	"@graftland/loader/test/resolver-lifetime.test/Missing",
) {}

describe("resolver leases", () => {
	it.effect.each(["active", "pending", "failed"])(
		"keeps the lease until the %s entry is removed",
		(state) =>
			Effect.gen(function* () {
				const leases = yield* Ref.make(0)
				const plugin = Plugin.make({
					name: "leased",
					config: Schema.String,
					apply: () =>
						state === "failed" ? Effect.fail("Activation failed") : Effect.void,
				})
				const resolver = yield* ModuleResolver.make({
					base: "/app",
					importer: () =>
						Effect.acquireRelease(
							Ref.update(leases, (n) => n + 1),
							() => Ref.update(leases, (n) => n - 1),
						).pipe(Effect.as({ default: plugin })),
				})
				yield* Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "a",
							name: "leased",
							config: "first",
							...(state === "pending" ? { inject: [Missing.key] } : {}),
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					const acquired = yield* Ref.get(leases)
					assert.strictEqual(acquired, 1)
					yield* loader.update("a", { config: "second" })
					yield* loader.ready
					const retained = yield* Ref.get(leases)
					assert.strictEqual(retained, 1)
					yield* loader.remove("a")
					yield* loader.ready
					const released = yield* Ref.get(leases)
					assert.strictEqual(released, 0)
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Graft.layer.pipe(
							Layer.provide(
								Layer.succeed(ModuleResolver.ModuleResolver, resolver),
							),
						),
					),
				)
			}).pipe(Effect.provide(Path.layer)),
	)
})

it.effect(
	"retains only the current observation generation across failed imports and removal",
	() =>
		Effect.gen(function* () {
			const observations = yield* Ref.make(0)
			const resources = yield* Ref.make(0)
			const attempts = yield* Ref.make(0)
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: (_name, { observationScope }) =>
					Effect.gen(function* () {
						yield* Ref.update(attempts, (count) => count + 1)
						yield* Effect.acquireRelease(
							Ref.update(observations, (count) => count + 1),
							() => Ref.update(observations, (count) => count - 1),
						).pipe(Scope.provide(observationScope))
						yield* Effect.acquireRelease(
							Ref.update(resources, (count) => count + 1),
							() => Ref.update(resources, (count) => count - 1),
						)
						return yield* Effect.fail("Import failed")
					}),
			})
			yield* Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [{ id: "broken", name: "broken" }])
				const loader = yield* loaderService
				yield* loader.ready
				const first = yield* Ref.get(observations)
				const cleaned = yield* Ref.get(resources)
				assert.strictEqual(first, 1)
				assert.strictEqual(cleaned, 0)
				for (const expected of [2, 3]) {
					yield* loader.retry
					yield* loader.ready
					const tries = yield* Ref.get(attempts)
					const retained = yield* Ref.get(observations)
					const activeResources = yield* Ref.get(resources)
					assert.strictEqual(tries, expected)
					assert.strictEqual(retained, 1)
					assert.strictEqual(activeResources, 0)
				}
				yield* loader.remove("broken")
				yield* loader.ready
				const released = yield* Ref.get(observations)
				assert.strictEqual(released, 0)
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Layer.provideMerge(
						Graft.layer,
						Layer.succeed(ModuleResolver.ModuleResolver, resolver),
					),
				),
			)
		}).pipe(Effect.provide(Path.layer)),
)
