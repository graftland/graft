import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Option,
	Ref,
	Schema,
	Stream,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, type Fork } from "@graftland/graft"

import { Intercept, Loader } from "../src/index.ts"
import { fixture, loaderService, run } from "./utils.ts"

const Settings = Context.Reference(
	"@graftland/loader/test/intercept.test/Settings",
	{ defaultValue: () => ({ color: "blue", size: 12 }) },
)

const settingsLayer = Intercept.layer([
	Intercept.make(
		Settings,
		Schema.Struct({
			color: Schema.optionalKey(Schema.Trim),
			size: Schema.optionalKey(Schema.Finite),
		}),
		(outer, patch) => ({ ...outer, ...patch }),
	),
])

const flatten = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<Fork.ForkTree> =>
	Array.flatMap(trees, (tree) => [tree, ...flatten(tree.children)])

const failedEntry = (name: string) =>
	Graft.forks.pipe(
		Stream.runHead,
		Effect.map((trees) => {
			const entry = Option.getOrThrow(
				Array.findFirst(
					flatten(Option.getOrThrow(trees)),
					(tree) => tree.name === name,
				),
			)
			assert.strictEqual(entry.state._tag, "Failed")
			if (entry.state._tag !== "Failed")
				throw new Error("Expected a failed entry")
			return Option.getOrThrow(Cause.findErrorOption(entry.state.cause))
		}),
	)

describe("registered intercepts", () => {
	it.effect(
		"decodes nested patches over their parent and keeps siblings isolated",
		() =>
			Effect.gen(function* () {
				const values = yield* Ref.make<
					ReadonlyArray<Context.Service.Shape<typeof Settings>>
				>([])

				yield* run({ settings: fixture("intercept-settings-1780") })(() =>
					Effect.gen(function* () {
						yield* Graft.plugin(Loader.plugin, [
							{
								id: "group",
								name: "group",
								group: true,
								intercept: { [Settings.key]: { color: " red " } },
								config: [
									{
										id: "nested",
										name: "settings",
										intercept: { [Settings.key]: { size: 24 } },
									},
								],
							},
							{ id: "sibling", name: "settings" },
						])
						const loader = yield* loaderService
						yield* loader.ready
						const observed = yield* Ref.get(values)
						assert.sameDeepMembers(Array.fromIterable(observed), [
							{ color: "red", size: 24 },
							{ color: "blue", size: 12 },
						])
					}),
				).pipe(
					Effect.provideService(
						Context.Service<{ readonly values: typeof values }>(
							"loader/fixture/intercept-settings-1780",
						),
						{ values },
					),
					Effect.provide(settingsLayer),
				)
			}),
	)

	it.effect(
		"fails an unregistered key even when the entry also awaits a missing injection",
		() =>
			run({ settings: fixture("intercept-settings-2671") })(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "entry",
							name: "settings",
							inject: ["missing"],
							intercept: { [Settings.key]: { color: "red" } },
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					const error = yield* failedEntry("settings")
					assert(Schema.is(Intercept.UnregisteredReference)(error))
					assert.strictEqual(error.key, Settings.key)
				}),
			),
	)

	it.effect(
		"rejects invalid patch types before apply and recovers after correcting the entry",
		() =>
			Effect.gen(function* () {
				const observed =
					yield* Deferred.make<Context.Service.Shape<typeof Settings>>()

				yield* run({ settings: fixture("intercept-settings-3722") })(() =>
					Effect.gen(function* () {
						yield* Graft.plugin(Loader.plugin, [
							{
								id: "entry",
								name: "settings",
								intercept: { [Settings.key]: { size: "large" } },
							},
						])
						const loader = yield* loaderService
						yield* loader.ready
						const error = yield* failedEntry("settings")
						assert(Schema.is(Intercept.InvalidIntercept)(error))
						assert.strictEqual(error.key, Settings.key)
						assert(Schema.isSchemaError(error.cause))
						const started = yield* Deferred.isDone(observed)
						assert.isFalse(started)
						yield* loader.update("entry", {
							intercept: { [Settings.key]: { size: 24 } },
						})
						yield* loader.ready
						const value = yield* Deferred.await(observed)
						assert.deepStrictEqual(value, { color: "blue", size: 24 })
					}),
				).pipe(
					Effect.provideService(
						Context.Service<{ readonly observed: typeof observed }>(
							"loader/fixture/intercept-settings-3722",
						),
						{ observed },
					),
					Effect.provide(settingsLayer),
				)
			}),
	)

	it.effect("supports schema-checked scalar replacements", () =>
		Effect.gen(function* () {
			const formal = Context.Reference(
				"@graftland/loader/test/intercept.test/formal",
				{ defaultValue: () => false },
			)
			const observed = yield* Deferred.make<boolean>()

			yield* run({ formal: fixture("intercept-formal-5098") })(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{ id: "formal", name: "formal", intercept: { [formal.key]: true } },
					])
					const loader = yield* loaderService
					yield* loader.ready
					const value = yield* Deferred.await(observed)
					assert.isTrue(value)
				}),
			).pipe(
				Effect.provideService(
					Context.Service<{ readonly observed: typeof observed }>(
						"loader/fixture/intercept-formal-5098",
					),
					{ observed },
				),
				Effect.provide(
					Intercept.layer([
						Intercept.make(formal, Schema.Boolean, (_, value) => value),
					]),
				),
			)
		}),
	)

	it("does not infer a wider reference type from a merge function", () => {
		// @ts-expect-error The registered merge must return Settings' complete value type.
		Intercept.make(Settings, Schema.String, (_, value) => value)
	})
	it.effect("merges string intercepts over reference defaults", () =>
		Effect.gen(function* () {
			const observed = yield* Deferred.make<{
				readonly color: string
				readonly size: number
			}>()

			yield* run({ settings: fixture("intercept-settings-6225") })(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "settings",
							name: "settings",
							intercept: { [Settings.key]: { color: "red" } },
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					const settings = yield* Deferred.await(observed)
					assert.deepStrictEqual(settings, { color: "red", size: 12 })
				}),
			).pipe(
				Effect.provideService(
					Context.Service<{ readonly observed: typeof observed }>(
						"loader/fixture/intercept-settings-6225",
					),
					{ observed },
				),
				Effect.provide(
					Intercept.layer([
						Intercept.make(
							Settings,
							Schema.Struct({
								color: Schema.optionalKey(Schema.String),
								size: Schema.optionalKey(Schema.Finite),
							}),
							(outer, patch) => ({ ...outer, ...patch }),
						),
					]),
				),
			)
		}),
	)
})
