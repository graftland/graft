import { assert, it } from "@effect/vitest"
import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Stream,
	Ref,
	Schema,
} from "effect"
import { Entry, Loader, ModuleResolver } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

it.effect.each(["direct", "nested", "injected group"])(
	"edits one leaf without refreshing a healthy sibling through %s entries",
	(kind) =>
		Effect.gen(function* () {
			const reads = yield* Ref.make(0)
			const current = yield* Ref.make("before")
			const observed = yield* Ref.make<ReadonlyArray<string>>([])
			class Gate extends Context.Service<Gate, string>()(
				"@graftland/loader/test/incremental-reconcile.test/Gate",
			) {}
			const leaf = Plugin.make({
				name: "leaf",
				config: Schema.String,
				apply: (value) => Ref.update(observed, Array.append(value)),
			})
			const environment = Layer.mergeAll(
				ModuleResolver.fromRecord({ leaf }),
				ConfigProvider.layer(
					ConfigProvider.make(() =>
						Ref.update(reads, (n) => n + 1).pipe(
							Effect.andThen(Ref.get(current)),
							Effect.map(ConfigProvider.makeValue),
						),
					),
				),
			)
			yield* Effect.gen(function* () {
				yield* Graft.provide(Gate, "open")
				const children = [
					{ id: "edit", name: "leaf", config: "first" },
					{
						id: "keep",
						name: "leaf",
						config: new Entry.Env({ name: "VALUE" }),
					},
				]
				yield* Graft.plugin(
					Loader.plugin,
					kind === "direct"
						? children
						: [
								{
									id: "group",
									name: "group",
									group: true,
									config: children,
									...(kind === "injected group" ? { inject: [Gate.key] } : {}),
								},
							],
				)
				const loader = yield* loaderService
				yield* loader.ready
				yield* Ref.set(current, "after")
				yield* Ref.set(reads, 0)
				yield* loader.update("edit", { config: "second" })
				yield* loader.ready
				const checked1 = yield* Ref.get(reads)

				assert.strictEqual(checked1, 0)
				const checked2 = yield* Ref.get(observed)

				assert.sameMembers([...checked2], ["first", "before", "second"])
				yield* loader.retry
				yield* loader.ready
				const checked3 = yield* Ref.get(reads)

				assert.strictEqual(checked3, 1)
				const checked4 = yield* Ref.get(observed)

				assert.sameMembers(
					[...checked4],
					["first", "before", "second", "after"],
				)
				const entries = yield* loader.entries
				yield* loader.root.update(entries)
				yield* loader.ready
				const checked5 = yield* Ref.get(reads)

				assert.strictEqual(checked5, 2)
				const snapshot = yield* Stream.runHead(Graft.forks)
				const trees = Option.getOrThrow(snapshot)
				const flatten = (nodes: typeof trees): typeof trees =>
					Array.flatMap(nodes, (node) => [node, ...flatten(node.children)])
				const rootInput = Option.getOrThrow(
					Array.findFirst(flatten(trees), (node) => node.id === loader.root.id),
				).input
				yield* loader.root.update(rootInput)
				yield* loader.ready
				yield* loader.update("edit", { config: "third" })
				yield* loader.ready
				const afterDirectRefresh = yield* Ref.get(reads)
				assert.strictEqual(afterDirectRefresh, 3)
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, environment)),
			)
		}),
)

it.effect(
	"starts sibling updates before a slow update finishes and waits for both",
	() =>
		Effect.gen(function* () {
			const slow = yield* Deferred.make<void>()
			const fast = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const done = yield* Deferred.make<void>()
			const leaf = Plugin.make({
				name: "leaf",
				config: Schema.String,
				apply: (id) =>
					Effect.succeed((_next: string) =>
						Deferred.succeed(id === "slow" ? slow : fast, undefined).pipe(
							Effect.andThen(
								id === "slow" ? Deferred.await(release) : Effect.void,
							),
							Effect.as(true),
						),
					),
			})
			yield* run(() => ({ leaf }))(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{ id: "slow", name: "leaf", config: "slow" },
						{ id: "fast", name: "leaf", config: "fast" },
					])
					const loader = yield* loaderService
					yield* loader.ready
					const updated = yield* loader.root
						.update([
							{ id: "slow", name: "leaf", config: "next" },
							{ id: "fast", name: "leaf", config: "next" },
						])
						.pipe(
							Effect.andThen(Deferred.succeed(done, undefined)),
							Effect.forkScoped,
						)
					yield* Deferred.await(slow)
					yield* Deferred.await(fast)
					const checked6 = yield* Deferred.isDone(done)

					assert.isFalse(checked6)
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(updated)
					yield* loader.ready
				}),
			)
		}),
)

it.effect("starts all removals before waiting for dependent cleanup", () =>
	Effect.gen(function* () {
		const first = yield* Deferred.make<void>()
		const second = yield* Deferred.make<void>()
		const leaf = Plugin.make({
			name: "leaf",
			config: Schema.String,
			apply: (id) =>
				Effect.addFinalizer(() =>
					Deferred.succeed(id === "first" ? first : second, undefined).pipe(
						Effect.andThen(Deferred.await(id === "first" ? second : first)),
					),
				),
		})
		yield* run(() => ({ leaf }))(() =>
			Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{ id: "first", name: "leaf", config: "first" },
					{ id: "second", name: "leaf", config: "second" },
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* loader.root.update([])
				yield* loader.ready
				const checked7 = yield* Deferred.isDone(first)

				assert.isTrue(checked7)
				const checked8 = yield* Deferred.isDone(second)

				assert.isTrue(checked8)
			}),
		)
	}),
)
