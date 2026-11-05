import { Context, Deferred, Effect, Layer, Option, Ref } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "../src/index.ts"

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
				const Read = Event.make<[], string>("ambient-read")
				const switched = yield* Deferred.make<void>()
				const consumer = Plugin.make({
					name: "consumer",
					inject: [Service],
					apply: () =>
						Effect.gen(function* () {
							const value = yield* Service
							yield* Event.on(Read, () => Effect.succeed(value))
							if (value === "dynamic")
								yield* Deferred.succeed(switched, undefined)
						}),
				})
				const old = yield* Graft.plugin(consumer)
				yield* old.await
				yield* Graft.provide(Service, "dynamic")
				yield* Deferred.await(switched)
				const recent = yield* Graft.plugin(consumer)
				yield* recent.await
				const values = yield* Event.parallel(Read)
				assert.deepStrictEqual(values, ["dynamic", "dynamic"])
			}).pipe(Effect.scoped, Effect.provide(Layer.fresh(ambientLayer))),
	)

	it.effect(
		"preserves inherited environment services after publication in another realm",
		() =>
			Effect.gen(function* () {
				const seen = yield* Ref.make(Option.none<string>())
				const consumer = Plugin.make({
					name: "environment reader",
					apply: () =>
						Effect.flatMap(Effect.serviceOption(Service), (value) =>
							Ref.set(seen, value),
						),
				})
				const before = yield* Graft.plugin(consumer)
				yield* before.await
				const initial = yield* Ref.get(seen)
				assert.deepStrictEqual(initial, Option.some("ambient"))
				const isolated = yield* Graft.plugin(
					Plugin.service(Service, Effect.succeed("private"), {
						name: "isolated provider",
					}),
					undefined,
					{ isolate: [Service] },
				)
				yield* isolated.await
				yield* isolated.dispose
				const after = yield* Graft.plugin(consumer)
				yield* after.await
				const subsequent = yield* Ref.get(seen)
				assert.deepStrictEqual(subsequent, Option.some("ambient"))
			}).pipe(Effect.scoped, Effect.provide(Layer.fresh(ambientLayer))),
	)
})
