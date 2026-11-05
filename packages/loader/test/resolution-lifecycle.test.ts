import {
	Array,
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Path,
	Ref,
	Schema,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin, type Fork } from "@graftland/graft"

import { Intercept, Loader, ModuleResolver } from "../src/index.ts"
import { loaderService } from "./utils.ts"

const Settings = Context.Reference(
	"@graftland/loader/test/resolution-lifecycle/Settings",
	{
		defaultValue: () => "default",
	},
)

const flatten = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<Fork.ForkTree> =>
	Array.flatMap(trees, (tree) => [tree, ...flatten(tree.children)])

it.effect(
	"preserves intercepted fallback through a provision-injecting group",
	() =>
		Effect.gen(function* () {
			const observed = yield* Deferred.make<string>()
			const consumer = Plugin.make({
				name: "consumer",
				apply: () =>
					Effect.flatMap(Settings, (value) =>
						Deferred.succeed(observed, value),
					).pipe(Effect.asVoid),
			})
			const environment = Layer.merge(
				ModuleResolver.fromRecord({ consumer }),
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

it.effect(
	"closes resolver resources if the loader closes during resolution",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const count = yield* Ref.make(0)
			const resolver = Layer.succeed(ModuleResolver.ModuleResolver, {
				importModule: (specifier) =>
					Effect.fail(
						ModuleResolver.ModuleInvalid.make({
							specifier,
							cause: "Unused in this fixture",
						}),
					),
				resolve: () =>
					Effect.acquireRelease(
						Ref.update(count, (n) => n + 1),
						() => Ref.update(count, (n) => n - 1),
					).pipe(
						Effect.andThen(Deferred.succeed(entered, undefined)),
						Effect.andThen(Effect.never),
					),
			})
			yield* Effect.gen(function* () {
				const owner = yield* Graft.plugin(Loader.plugin, [])
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.create({ id: "slow", name: "slow" })
				yield* Deferred.await(entered)
				const acquired = yield* Ref.get(count)
				assert.strictEqual(acquired, 1)
				yield* owner.dispose
				const released = yield* Ref.get(count)
				assert.strictEqual(released, 0)
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, resolver)),
			)
		}),
)

it.effect("can remove an entry while its module is still resolving", () =>
	Effect.gen(function* () {
		const entered = yield* Deferred.make<void>()
		const resolver = ModuleResolver.layer({
			base: "/app",
			importer: () =>
				Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
		}).pipe(Layer.provide(Path.layer))
		yield* Effect.gen(function* () {
			yield* Graft.plugin(Loader.plugin, [])
			const loader = yield* loaderService
			yield* loader.ready
			yield* loader.create({ id: "slow", name: "slow" })
			yield* Deferred.await(entered)
			yield* loader.remove("slow")
			const entries = yield* loader.entries
			assert.deepStrictEqual(entries, [])
			yield* loader.ready
			const trees = yield* Stream.runHead(Graft.forks)
			assert.isFalse(
				Array.some(
					flatten(Option.getOrThrow(trees)),
					(tree) => tree.name === "slow",
				),
			)
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.provideMerge(Graft.layer, resolver)),
		)
	}),
)

it.effect(
	"keeps resolution Loading while siblings and later targets can progress",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const started = yield* Deferred.make<void>()
			const updated = yield* Deferred.make<void>()
			const attempts = yield* Ref.make(0)
			const leases = yield* Ref.make(0)
			const healthy = Plugin.make({
				name: "healthy",
				config: Schema.String,
				apply: () =>
					Deferred.succeed(started, undefined).pipe(
						Effect.as((_next: string) =>
							Deferred.succeed(updated, undefined).pipe(Effect.as(true)),
						),
					),
			})
			const resolver = ModuleResolver.layer({
				base: "/app",
				importer: (name) =>
					name === "slow"
						? Effect.gen(function* () {
								yield* Ref.update(attempts, (n) => n + 1)
								yield* Effect.acquireRelease(
									Ref.update(leases, (n) => n + 1),
									() => Ref.update(leases, (n) => n - 1),
								)
								yield* Deferred.succeed(entered, undefined)
								return yield* Effect.never
							})
						: Effect.succeed({ default: healthy }),
			}).pipe(Layer.provide(Path.layer))
			yield* Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{ id: "slow", name: "slow" },
					{ id: "healthy", name: "healthy", config: "initial" },
				])
				const loader = yield* loaderService
				yield* Deferred.await(entered)
				yield* Deferred.await(started)
				const trees = yield* Stream.runHead(Graft.forks)
				const slow = Option.getOrThrow(
					Array.findFirst(
						flatten(Option.getOrThrow(trees)),
						(tree) => tree.name === "slow",
					),
				)
				assert.strictEqual(slow.state._tag, "Loading")
				const waiting = yield* loader.ready.pipe(
					Effect.timeoutOption("1 second"),
					Effect.forkChild,
				)
				yield* TestClock.adjust("1 second")
				const early = yield* Fiber.join(waiting)
				assert.isTrue(Option.isNone(early))
				yield* loader.update("healthy", { config: "updated" })
				yield* Deferred.await(updated)
				const count = yield* Ref.get(attempts)
				assert.strictEqual(count, 1)
				yield* loader.remove("slow")
				// Completion is a lifecycle barrier, independent of synthetic timer scheduling.
				yield* loader.ready
				const remaining = yield* Ref.get(leases)
				assert.strictEqual(remaining, 0)
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, resolver)),
			)
		}),
)

for (const action of ["remove", "replace", "disable", "update"] as const) {
	it.effect(`ignores a late importer result after ${action}`, () =>
		Effect.gen(function* () {
			// A native import's promise may settle after its waiting fiber was interrupted.
			const imported = Promise.withResolvers<unknown>()
			const entered = yield* Deferred.make<void>()
			const attempts = yield* Ref.make(0)
			const applied = yield* Ref.make<ReadonlyArray<string>>([])
			const stale = Plugin.make({
				name: "stale",
				apply: () => Ref.update(applied, Array.append("stale")),
			})
			const latest = Plugin.make({
				name: "latest",
				config: Schema.String,
				apply: (value) => Ref.update(applied, Array.append(value)),
			})
			const resolver = ModuleResolver.layer({
				base: "/app",
				importer: () =>
					Effect.gen(function* () {
						const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
						if (attempt > 1) return { default: latest }
						yield* Deferred.succeed(entered, undefined)
						return yield* Effect.promise(() => imported.promise)
					}),
			}).pipe(Layer.provide(Path.layer))
			yield* Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [])
				const loader = yield* loaderService
				yield* loader.create({ id: "entry", name: "slow", config: "old" })
				yield* Deferred.await(entered)
				if (action === "remove") yield* loader.remove("entry")
				else if (action === "replace")
					yield* loader.update("entry", { name: "latest", config: "latest" })
				else if (action === "disable")
					yield* loader.update("entry", { disabled: true })
				else yield* loader.update("entry", { config: "latest" })
				yield* loader.ready
				imported.resolve({ default: stale })
				yield* Effect.promise(() => imported.promise)
				yield* loader.create({ id: "barrier", name: "unused", disabled: true })
				yield* loader.ready
				const values = yield* Ref.get(applied)
				assert.deepStrictEqual(
					values,
					action === "replace" || action === "update" ? ["latest"] : [],
				)
				const trees = yield* Stream.runHead(Graft.forks)
				assert.isFalse(
					Array.some(
						flatten(Option.getOrThrow(trees)),
						(tree) => tree.name === "stale",
					),
				)
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, resolver)),
			)
		}),
	)
}
