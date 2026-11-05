import {
	Array,
	Cause,
	ConfigProvider,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Ref,
	Schema,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin, type Fork } from "@graftland/graft"

import {
	Entry,
	Include,
	Intercept,
	Loader,
	ModuleResolver,
} from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

const Setting = Context.Reference(
	"@graftland/loader/test/intercept-env.test/Setting",
	{ defaultValue: () => "default" },
)
const registry = Intercept.layer([
	Intercept.make(Setting, Schema.String, (_outer, value) => value),
])
const flatten = (
	nodes: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<Fork.ForkTree> =>
	Array.flatMap(nodes, (node) => [node, ...flatten(node.children)])

it.effect.each(["literal", "env"])(
	"loads a %s intercept and keeps environment tags in persisted targets",
	(mode) =>
		Effect.gen(function* () {
			const observations = yield* Ref.make<ReadonlyArray<unknown>>([])
			const leaf = Plugin.make({
				name: "leaf",
				config: Schema.String,
				apply: (config) =>
					Effect.flatMap(Setting, (setting) =>
						Ref.update(observations, Array.append({ config, setting })),
					),
			})
			yield* run(() => ({ leaf }))(() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const directory = yield* fs.makeTempDirectoryScoped()
					const file = `${directory}/graft.yml`
					yield* fs.writeFileString(
						file,
						`- id: leaf\n  name: leaf\n  config: !env GREETING\n  intercept:\n    "${Setting.key}": ${mode === "env" ? "!env GREETING" : "hi"}\n`,
					)
					const included = yield* Graft.plugin(Include.Include, { path: file })
					yield* included.await
					const loader = yield* loaderService
					yield* loader.ready
					const observed = yield* Ref.get(observations)
					assert.deepStrictEqual(observed, [{ config: "hi", setting: "hi" }])
					yield* loader.create({ id: "marker", name: "unused", disabled: true })
					const entries = yield* loader.entries
					assert(entries[0]?.config instanceof Entry.Env)
					if (mode === "env")
						assert(entries[0]?.intercept?.[Setting.key] instanceof Entry.Env)
					const text = yield* fs.readFileString(file)
					assert.include(text, "!env GREETING")
					assert.notInclude(text, "config: hi")
					if (mode === "env")
						assert.include(text, `"${Setting.key}": !env GREETING`)
				}),
			).pipe(Effect.provide(registry))
		}),
)

it.effect(
	"resolves nested intercept values before decoding the registered patch",
	() =>
		Effect.gen(function* () {
			const Settings = Context.Reference(
				"@graftland/loader/test/intercept-env.test/Settings",
				{
					defaultValue: () => ({
						tags: [] as ReadonlyArray<string>,
						label: "default",
					}),
				},
			)
			const registration = Intercept.layer([
				Intercept.make(
					Settings,
					Schema.Struct({ tags: Schema.Array(Schema.String) }),
					(outer, patch) => ({ ...outer, ...patch }),
				),
			])
			const seen = yield* Ref.make<unknown>(undefined)
			const leaf = Plugin.make({
				name: "leaf",
				apply: () => Effect.flatMap(Settings, (value) => Ref.set(seen, value)),
			})
			yield* run(() => ({ leaf }))(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "leaf",
							name: "leaf",
							intercept: {
								[Settings.key]: { tags: [new Entry.Env({ name: "GREETING" })] },
							},
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					const observed = yield* Ref.get(seen)
					assert.deepStrictEqual(observed, { tags: ["hi"], label: "default" })
				}),
			).pipe(Effect.provide(registration))
		}),
)

it.effect.each([true, false])(
	"keeps a missing intercept environment variable local to its child (disabled: %s)",
	(disabled) =>
		Effect.gen(function* () {
			const observed = yield* Ref.make<ReadonlyArray<string>>([])
			const leaf = Plugin.make({
				name: "leaf",
				apply: () =>
					Effect.flatMap(Setting, (value) =>
						Ref.update(observed, Array.append(value)),
					),
			})
			yield* run(() => ({ leaf }))(() =>
				Effect.gen(function* () {
					const children = [
						{
							id: "unavailable",
							name: "leaf",
							disabled,
							intercept: { [Setting.key]: new Entry.Env({ name: "MISSING" }) },
						},
						{ id: "healthy", name: "leaf" },
					]
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "group",
							name: "group",
							group: true,
							intercept: { [Setting.key]: new Entry.Env({ name: "GREETING" }) },
							config: children,
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					const first = yield* Ref.get(observed)
					assert.deepStrictEqual(first, ["hi"])
					yield* loader.update("group", {
						config: [...children, { id: "new", name: "leaf" }],
					})
					yield* loader.ready
					const after = yield* Ref.get(observed)
					assert.deepStrictEqual(after, ["hi", "hi"])
					const trees = yield* Stream.runHead(Graft.forks)
					const failures = Array.filter(
						flatten(Option.getOrThrow(trees)),
						(node) => node.state._tag === "Failed",
					)
					assert.strictEqual(failures.length, disabled ? 0 : 1)
					for (const failure of failures) {
						assert(failure.state._tag === "Failed")
						assert.deepStrictEqual(
							Array.map(failure.state.cause.reasons, (reason) =>
								Cause.isFailReason(reason) &&
								typeof reason.error === "object" &&
								reason.error !== null &&
								"_tag" in reason.error
									? reason.error._tag
									: undefined,
							),
							["ConfigError"],
						)
					}
				}),
			).pipe(Effect.provide(registry))
		}),
)

it.effect(
	"retries a failed intercept after its environment value becomes available",
	() =>
		Effect.gen(function* () {
			const available = yield* Ref.make(false)
			const observed = yield* Ref.make<ReadonlyArray<string>>([])
			const leaf = Plugin.make({
				name: "leaf",
				apply: () =>
					Effect.flatMap(Setting, (value) =>
						Ref.update(observed, Array.append(value)),
					),
			})
			const provider = ConfigProvider.make(() =>
				Effect.map(Ref.get(available), (available) =>
					available ? ConfigProvider.makeValue("recovered") : undefined,
				),
			)
			const environment = Layer.mergeAll(
				registry,
				ConfigProvider.layer(provider),
				ModuleResolver.fromRecord({ leaf }),
			)
			yield* Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{
						id: "leaf",
						name: "leaf",
						intercept: { [Setting.key]: new Entry.Env({ name: "SETTING" }) },
					},
				])
				const loader = yield* loaderService
				yield* loader.ready
				const initial = yield* Ref.get(observed)
				assert.deepStrictEqual(initial, [])
				yield* Ref.set(available, true)
				yield* loader.retry
				yield* loader.ready
				const recovered = yield* Ref.get(observed)
				assert.deepStrictEqual(recovered, ["recovered"])
				yield* loader.update("leaf", {
					intercept: { [Setting.key]: "replacement" },
				})
				yield* loader.ready
				const replaced = yield* Ref.get(observed)
				assert.deepStrictEqual(replaced, ["recovered", "replacement"])
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, environment)),
			)
		}),
)

it.effect(
	"validates resolved environment values against the registered schema",
	() =>
		Effect.gen(function* () {
			const started = yield* Ref.make(false)
			const leaf = Plugin.make({
				name: "leaf",
				apply: () => Ref.set(started, true),
			})
			yield* run(() => ({ leaf }))(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "leaf",
							name: "leaf",
							intercept: { [Setting.key]: new Entry.Env({ name: "GREETING" }) },
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					const didStart = yield* Ref.get(started)
					assert.isFalse(didStart)
					const trees = yield* Stream.runHead(Graft.forks)
					const failed = Array.findFirst(
						flatten(Option.getOrThrow(trees)),
						(node) => node.state._tag === "Failed",
					)
					assert(Option.isSome(failed))
					assert(failed.value.state._tag === "Failed")
					const error = Option.getOrThrow(
						Cause.findErrorOption(failed.value.state.cause),
					)
					assert(Schema.is(Intercept.InvalidIntercept)(error))
					assert.strictEqual(error.key, Setting.key)
				}),
			).pipe(
				Effect.provide(
					Intercept.layer([
						Intercept.make(
							Setting,
							Schema.Literal("allowed"),
							(_outer, value) => value,
						),
					]),
				),
			)
		}),
)
