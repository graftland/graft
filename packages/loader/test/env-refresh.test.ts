import { assert, it } from "@effect/vitest"
import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	Layer,
	Option,
	Queue,
	Record,
	Ref,
	Schema,
	type Scope,
} from "effect"
import {
	Entry,
	Group,
	Intercept,
	Loader,
	ModuleResolver,
} from "../src/index.ts"
import { loaderService } from "./utils.ts"

const Setting = Context.Reference(
	"@graftland/loader/test/env-refresh.test/Setting",
	{ defaultValue: () => "default" },
)
const registry = Intercept.layer([
	Intercept.make(Setting, Schema.String, (_outer, value) => value),
])

/** An environment that tests can change while entries run. */
const makeEnvironment = (initial: Record<string, string>) =>
	Effect.map(Ref.make(initial), (variables) => ({
		variables,
		provider: ConfigProvider.make((path) =>
			Effect.map(Ref.get(variables), (variables) => {
				const value = Record.get(variables, String(path[0]))
				return value._tag === "Some"
					? ConfigProvider.makeValue(value.value)
					: undefined
			}),
		),
	}))

const makeLeaf = Effect.map(
	Ref.make<ReadonlyArray<string>>([]),
	(observed) => ({
		observed,
		leaf: Plugin.make({
			name: "leaf",
			config: Schema.String,
			apply: (value) =>
				Effect.flatMap(Setting, (setting) =>
					Ref.update(observed, Array.append(`${value}/${setting}`)),
				),
		}),
	}),
)

const entry = {
	id: "leaf",
	name: "leaf",
	config: new Entry.Env({ name: "VALUE" }),
	intercept: { [Setting.key]: new Entry.Env({ name: "SETTING" }) },
}

it.effect(
	"retry reads changed environment values in config and intercepts",
	() =>
		Effect.gen(function* () {
			const { variables, provider } = yield* makeEnvironment({
				VALUE: "a",
				SETTING: "x",
			})
			const { observed, leaf } = yield* makeLeaf
			yield* Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [entry])
				const loader = yield* loaderService
				yield* loader.ready
				yield* Ref.update(variables, Record.set("VALUE", "b"))
				yield* loader.retry
				yield* loader.ready
				yield* Ref.update(variables, Record.set("SETTING", "y"))
				yield* loader.retry
				yield* loader.ready
				yield* loader.retry
				yield* loader.ready
				const values = yield* Ref.get(observed)
				assert.deepStrictEqual(values, ["a/x", "b/x", "b/y"])
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Layer.provideMerge(
						Graft.layer,
						Layer.mergeAll(
							registry,
							ConfigProvider.layer(provider),
							ModuleResolver.fromRecord({ leaf }),
						),
					),
				),
			)
		}),
)

it.effect("reads the environment after a slow import finishes", () =>
	Effect.gen(function* () {
		const { variables, provider } = yield* makeEnvironment({
			VALUE: "a",
			SETTING: "x",
		})
		const { observed, leaf } = yield* makeLeaf
		const requested = yield* Deferred.make<void>()
		const imported = yield* Deferred.make<void>()
		const resolver = Layer.succeed(ModuleResolver.ModuleResolver, {
			resolve: () =>
				Deferred.succeed(requested, undefined).pipe(
					Effect.andThen(Deferred.await(imported)),
					Effect.as<Plugin.Plugin>(leaf),
				),
		})
		yield* Effect.gen(function* () {
			yield* Graft.plugin(Loader.plugin, [entry])
			yield* Deferred.await(requested)
			yield* Ref.set(variables, { VALUE: "b", SETTING: "y" })
			yield* Deferred.succeed(imported, undefined)
			const loader = yield* loaderService
			yield* loader.ready
			const values = yield* Ref.get(observed)
			assert.deepStrictEqual(values, ["b/y"])
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.provideMerge(
					Graft.layer,
					Layer.mergeAll(registry, ConfigProvider.layer(provider), resolver),
				),
			),
		)
	}),
)

/** The first activation reads its environment, then waits in intercept resolution until released. */
const makeSlowLoad = Effect.gen(function* () {
	const starts = yield* Queue.unbounded<string>()
	const resolving = yield* Deferred.make<void>()
	const release = yield* Deferred.make<void>()
	const leaf = Plugin.make({
		name: "leaf",
		config: Schema.String,
		apply: (value) =>
			Effect.flatMap(Setting, (setting) =>
				Effect.asVoid(Queue.offer(starts, `${value}/${setting}`)),
			),
	})
	const registry = Intercept.layer([
		{
			key: Setting.key,
			schema: Schema.String,
			resolve: (input) =>
				Deferred.succeed(resolving, undefined).pipe(
					Effect.andThen(Deferred.await(release)),
					Effect.as(Graft.intercept(Setting, () => `${input}`)),
				),
		},
	])
	return {
		starts,
		resolving,
		release,
		layer: Layer.mergeAll(registry, ModuleResolver.fromRecord({ leaf })),
	}
})

it.effect("refreshes an entry that was still loading when reconciled", () =>
	Effect.gen(function* () {
		const { variables, provider } = yield* makeEnvironment({
			VALUE: "a",
			SETTING: "x",
		})
		const slow = yield* makeSlowLoad
		yield* Effect.gen(function* () {
			yield* Graft.plugin(Loader.plugin, [entry])
			yield* Deferred.await(slow.resolving)
			yield* Ref.set(variables, { VALUE: "b", SETTING: "y" })
			const loader = yield* loaderService
			// Returns once the root group has reconciled, while the entry still loads.
			yield* loader.root.update([entry])
			yield* Deferred.succeed(slow.release, undefined)
			// Ready also waits for the entry to read its environment again.
			yield* loader.ready
			const starts = yield* Queue.takeAll(slow.starts)
			assert.deepStrictEqual(starts, ["a/x", "b/y"])
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.provideMerge(
					Graft.layer,
					Layer.merge(slow.layer, ConfigProvider.layer(provider)),
				),
			),
		)
	}),
)

it.live("does not undo a later change to an entry that was loading", () =>
	Effect.gen(function* () {
		const { provider } = yield* makeEnvironment({
			VALUE: "a",
			OTHER: "o",
			SETTING: "x",
		})
		const slow = yield* makeSlowLoad
		yield* Effect.gen(function* () {
			yield* Graft.plugin(Loader.plugin, [entry])
			yield* Deferred.await(slow.resolving)
			const loader = yield* loaderService
			yield* loader.root.update([entry])
			yield* loader.root.update([
				{ ...entry, config: new Entry.Env({ name: "OTHER" }) },
			])
			yield* Deferred.succeed(slow.release, undefined)
			const first = yield* Queue.take(slow.starts)
			assert.strictEqual(first, "o/x")
			// A stale refresh would start the plugin again with the first entry.
			yield* loader.ready
			yield* Effect.sleep("50 millis")
			const later = yield* Queue.size(slow.starts)
			assert.strictEqual(later, 0)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.provideMerge(
					Graft.layer,
					Layer.merge(slow.layer, ConfigProvider.layer(provider)),
				),
			),
		)
	}),
)

it.live("ready waits while a loaded entry reads its environment again", () =>
	Effect.gen(function* () {
		const variables = yield* Ref.make<Record<string, string>>({
			VALUE: "a",
			SETTING: "x",
		})
		const blocking = yield* Ref.make(false)
		const reading = yield* Deferred.make<void>()
		const unblock = yield* Deferred.make<void>()
		// Once blocking, reads wait until unblocked, so the refresh stays in progress.
		const provider = ConfigProvider.make((path) =>
			Effect.gen(function* () {
				if (yield* Ref.get(blocking)) {
					yield* Deferred.succeed(reading, undefined)
					yield* Deferred.await(unblock)
				}
				const current = yield* Ref.get(variables)
				const value = Record.get(current, String(path[0]))
				return value._tag === "Some"
					? ConfigProvider.makeValue(value.value)
					: undefined
			}),
		)
		const slow = yield* makeSlowLoad
		yield* Effect.gen(function* () {
			yield* Graft.plugin(Loader.plugin, [entry])
			yield* Deferred.await(slow.resolving)
			yield* Ref.update(variables, Record.set("VALUE", "b"))
			yield* Ref.set(blocking, true)
			const loader = yield* loaderService
			yield* loader.root.update([entry])
			yield* Deferred.succeed(slow.release, undefined)
			yield* Deferred.await(reading)
			const ready = yield* Effect.forkChild(loader.ready)
			const early = yield* Fiber.await(ready).pipe(
				Effect.timeoutOption("50 millis"),
			)
			assert.isTrue(Option.isNone(early))
			yield* Ref.set(blocking, false)
			yield* Deferred.succeed(unblock, undefined)
			yield* Fiber.join(ready)
			const starts = yield* Queue.takeAll(slow.starts)
			assert.deepStrictEqual(starts, ["a/x", "b/x"])
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.provideMerge(
					Graft.layer,
					Layer.merge(slow.layer, ConfigProvider.layer(provider)),
				),
			),
		)
	}),
)

it.effect("retry refreshes children a loading group already started", () =>
	Effect.gen(function* () {
		const { variables, provider } = yield* makeEnvironment({ VALUE: "a" })
		const latest = yield* Ref.make(HashMap.empty<string, string>())
		const started = yield* Deferred.make<void>()
		const groupLoading = yield* Deferred.make<void>()
		const releaseGroup = yield* Deferred.make<void>()
		const reconciled = yield* Deferred.make<void>()
		// Plugin definitions erase requirements; this test delegates to Group with its declared services.
		const applyGroup = Group.Group.apply as (
			entries: ReadonlyArray<Entry.Entry>,
		) => Effect.Effect<
			void | Plugin.Update<
				ReadonlyArray<Entry.Entry>,
				never,
				ModuleResolver.ModuleResolver
			>,
			never,
			Graft.Graft | Scope.Scope | ModuleResolver.ModuleResolver
		>
		const heldGroup: typeof Group.Group = {
			...Group.Group,
			apply: (entries) =>
				applyGroup(entries).pipe(
					Effect.tap(() =>
						Array.some(entries, (entry) => entry.id === "leaf-0")
							? Deferred.succeed(groupLoading, undefined).pipe(
									Effect.andThen(Deferred.await(releaseGroup)),
								)
							: Effect.void,
					),
					Effect.map((update) =>
						update === undefined
							? undefined
							: (next: ReadonlyArray<Entry.Entry>) =>
									update(next).pipe(
										Effect.tap(() =>
											Array.some(entries, (entry) => entry.id === "group")
												? Deferred.succeed(reconciled, undefined)
												: Effect.void,
										),
									),
					),
				),
		}
		const leaf = Plugin.make({
			name: "leaf",
			config: Schema.Struct({ id: Schema.String, value: Schema.String }),
			apply: ({ id, value }) =>
				Ref.update(latest, HashMap.set(id, value)).pipe(
					Effect.andThen(Deferred.succeed(started, undefined)),
					Effect.asVoid,
				),
		})
		const ids = Array.makeBy(2, (n) => `leaf-${n}`)
		const group = {
			id: "group",
			name: "group",
			group: true,
			config: Array.map(ids, (id) => ({
				id,
				name: "leaf",
				config: { id, value: new Entry.Env({ name: "VALUE" }) },
			})),
		}
		yield* Effect.gen(function* () {
			yield* Graft.replace([[Group.Group, heldGroup]])
			yield* Graft.plugin(Loader.plugin, [group])
			const loader = yield* loaderService
			// Hold the actual group in Loading after its children have been registered.
			yield* Deferred.await(groupLoading)
			yield* Deferred.await(started)
			yield* Ref.set(variables, { VALUE: "b" })
			yield* loader.retry
			yield* Deferred.await(reconciled)
			yield* Deferred.succeed(releaseGroup, undefined)
			yield* loader.ready
			const values = yield* Ref.get(latest)
			const stale = Array.filter(ids, (id) =>
				Option.exists(HashMap.get(values, id), (value) => value !== "b"),
			)
			assert.strictEqual(HashMap.size(values), ids.length)
			assert.deepStrictEqual(stale, [])
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.provideMerge(
					Graft.layer,
					Layer.mergeAll(
						registry,
						ConfigProvider.layer(provider),
						ModuleResolver.fromRecord({ leaf }),
					),
				),
			),
		)
	}),
)
