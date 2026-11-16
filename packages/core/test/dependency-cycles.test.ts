import { Context, Deferred, Effect, Layer, Ref } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "../src/index.ts"
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
				const child = Layer.effect(Service, Effect.succeed("dynamic"))
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
							// Stop after three attempts to bound a broken restart loop.
							if (attempt === 3) {
								yield* Deferred.succeed(stopped, undefined)
								return yield* Effect.fail("restart loop")
							}
							yield* Service
							const mount = yield* Graft.mount(child, {
								name: "child provider",
							})
							yield* mount.await.pipe(
								Effect.tapError(() => Deferred.succeed(stopped, undefined)),
							)
						}),
					),
					{ name: "parent consumer", requires: [Service] },
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
		"rejects a publication that closes a cycle across sibling mounts",
		() =>
			Effect.gen(function* () {
				class Other extends Context.Service<Other, string>()(
					"@graftland/graft/test/dependency-cycles.test/Other",
				) {}
				const attempts = yield* Ref.make(0)
				const stopped = yield* Deferred.make<void>()
				const left = Layer.effect(
					Other,
					Effect.gen(function* () {
						const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
						if (attempt >= 3) {
							yield* Deferred.succeed(stopped, undefined)
							return yield* Effect.fail("restart loop")
						}
						yield* Service
						return "left"
					}),
				)
				const right = Layer.effectDiscard(
					Effect.gen(function* () {
						yield* Other
						const publication = yield* Graft.publish(Service, "right")
						yield* publication.await.pipe(
							Effect.tapError(() => Deferred.succeed(stopped, undefined)),
						)
					}),
				)
				const first = yield* Graft.mount(left, {
					name: "left provider",
					requires: [Service],
				})
				yield* first.await
				const second = yield* Graft.mount(right, {
					name: "right provider",
					requires: [Other],
				})
				yield* Deferred.await(stopped)
				yield* first.unmount
				yield* second.unmount
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
