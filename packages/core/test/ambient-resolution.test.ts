import { Array, Context, Deferred, Effect, Layer, Option, Ref } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "../src/index.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/ambient-resolution.test/Service",
) {}

const ambientLayer = Graft.layer.pipe(
	Layer.provideMerge(Layer.succeed(Service, "ambient")),
)

describe("ambient resolution", () => {
	it.effect(
		"gives old and new consumers the same service after publication",
		() =>
			Effect.gen(function* () {
				const values = yield* Ref.make<ReadonlyArray<string>>([])
				const switched = yield* Deferred.make<void>()
				const consumer = Layer.effectDiscard(
					Effect.gen(function* () {
						const value = yield* Service
						yield* Ref.update(values, Array.append(value))
						if (value === "dynamic")
							yield* Deferred.succeed(switched, undefined)
					}),
				)
				const old = yield* Graft.mount(consumer, {
					name: "consumer",
					requires: [Service],
				})
				yield* old.await
				const publication = yield* Graft.publish(Service, "dynamic")
				yield* publication.await
				yield* Deferred.await(switched)
				const recent = yield* Graft.mount(consumer, {
					name: "consumer",
					requires: [Service],
				})
				yield* recent.await
				const seen = yield* Ref.get(values)
				assert.deepStrictEqual(seen.slice(-2), ["dynamic", "dynamic"])
			}).pipe(Effect.scoped, Effect.provide(Layer.fresh(ambientLayer))),
	)

	it.effect(
		"preserves inherited environment services after publication in another realm",
		() =>
			Effect.gen(function* () {
				const seen = yield* Ref.make(Option.none<string>())
				const consumer = Layer.effectDiscard(
					Effect.flatMap(Effect.serviceOption(Service), (value) =>
						Ref.set(seen, value),
					),
				)
				const before = yield* Graft.mount(consumer, {
					name: "environment reader",
				})
				yield* before.await
				const initial = yield* Ref.get(seen)
				assert.deepStrictEqual(initial, Option.some("ambient"))
				const isolated = yield* Graft.mount(
					Layer.effect(Service, Effect.succeed("private")),
					{ name: "isolated provider", isolate: [Service] },
				)
				yield* isolated.await
				yield* isolated.unmount
				const after = yield* Graft.mount(consumer, {
					name: "environment reader",
				})
				yield* after.await
				const subsequent = yield* Ref.get(seen)
				assert.deepStrictEqual(subsequent, Option.some("ambient"))
			}).pipe(Effect.scoped, Effect.provide(Layer.fresh(ambientLayer))),
	)
})
