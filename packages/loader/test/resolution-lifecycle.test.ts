import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Intercept, Loader } from "../src/index.ts"
import { fixture, moduleLayer } from "./module-fixtures"
import { loaderService } from "./utils.ts"

const Settings = Context.Reference(
	"@graftland/loader/test/resolution-lifecycle/Settings",
	{
		defaultValue: () => "default",
	},
)

it.effect(
	"preserves intercepted fallback through a provision-injecting group",
	() =>
		Effect.gen(function* () {
			const observed = yield* Deferred.make<string>()

			const environment = Layer.merge(
				Layer.mergeAll(
					moduleLayer({
						consumer: fixture("resolution-lifecycle-consumer-1072"),
					}),
					Layer.succeed(
						Context.Service<{ readonly observed: typeof observed }>(
							"loader/fixture/resolution-lifecycle-consumer-1072",
						),
						{ observed },
					),
				),
				Intercept.layer([
					Intercept.make(Settings, Schema.String, (_, value) => value),
				]),
			)
			yield* Effect.gen(function* () {
				yield* Graft.provide(Settings, "provision")
				yield* Graft.plugin(Loader.plugin, [
					{
						id: "group",
						name: "group",
						group: true,
						inject: [Settings.key],
						intercept: { [Settings.key]: "intercept" },
						config: [{ id: "child", name: "consumer" }],
					},
				])
				const loader = yield* loaderService
				yield* loader.ready
				const value = yield* Deferred.await(observed)
				assert.strictEqual(value, "intercept")
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, environment)),
			)
		}),
)
