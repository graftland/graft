import { Context, Deferred, Effect, Layer, Ref } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "../src/index.ts"
import { reach } from "./utils.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/dependency-cycles.test/Service",
) {}

describe("dependency cycles", () => {
	it.effect(
		"rejects a child publication that repeatedly invalidates its parent",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0)
				const stopped = yield* Deferred.make<void>()
				const child = Plugin.service(Service, Effect.succeed("dynamic"), {
					name: "child provider",
				})
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "parent consumer",
						inject: [Service],
						apply: () =>
							Effect.gen(function* () {
								const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
								// Stop after three attempts to bound a broken restart loop.
								if (attempt === 3) {
									yield* Deferred.succeed(stopped, undefined)
									return yield* Effect.fail("restart loop")
								}
								const fork = yield* Graft.plugin(child)
								yield* fork.await.pipe(
									Effect.tapError(() => Deferred.succeed(stopped, undefined)),
								)
							}),
					}),
				)
				yield* Deferred.await(stopped)
				yield* reach(parent, "Failed")
				const count = yield* Ref.get(attempts)
				assert.strictEqual(count, 1)
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Layer.fresh(
						Graft.layer.pipe(Layer.provide(Layer.succeed(Service, "ambient"))),
					),
				),
			),
	)
	it.effect(
		"rejects a publication that closes a cycle across sibling activations",
		() =>
			Effect.gen(function* () {
				class Other extends Context.Service<Other, string>()(
					"@graftland/graft/test/dependency-cycles.test/Other",
				) {}
				const attempts = yield* Ref.make(0)
				const stopped = yield* Deferred.make<void>()
				const left = Plugin.make({
					name: "left provider",
					inject: [Service],
					apply: () =>
						Effect.gen(function* () {
							const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
							if (attempt >= 3) {
								yield* Deferred.succeed(stopped, undefined)
								return yield* Effect.fail("restart loop")
							}
							yield* Graft.provide(Other, "left")
						}),
				})
				const right = Plugin.make({
					name: "right provider",
					inject: [Other],
					apply: () =>
						Graft.provide(Service, "right").pipe(
							Effect.tapError(() => Deferred.succeed(stopped, undefined)),
						),
				})
				const first = yield* Graft.plugin(left)
				yield* first.await
				const second = yield* Graft.plugin(right)
				yield* Deferred.await(stopped)
				yield* first.dispose
				yield* second.dispose
				const count = yield* Ref.get(attempts)
				assert.strictEqual(count, 1)
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Layer.fresh(
						Graft.layer.pipe(Layer.provide(Layer.succeed(Service, "ambient"))),
					),
				),
			),
	)
})
