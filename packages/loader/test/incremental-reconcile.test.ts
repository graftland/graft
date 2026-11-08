import {
	Array,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Fiber,
	Option,
	Ref,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Entry, Loader } from "../src/index.ts"
import { fixture, loaderService, run } from "./utils.ts"

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

			const environment = ConfigProvider.layer(
				ConfigProvider.make(() =>
					Ref.update(reads, (n) => n + 1).pipe(
						Effect.andThen(Ref.get(current)),
						Effect.map(ConfigProvider.makeValue),
					),
				),
			)
			yield* run(
				{ leaf: fixture("incremental-reconcile-leaf-1163") },
				environment,
			)(() =>
				Effect.gen(function* () {
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
										...(kind === "injected group"
											? { inject: [Gate.key] }
											: {}),
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
						Array.findFirst(
							flatten(trees),
							(node) => node.id === loader.root.id,
						),
					).input
					yield* loader.root.update(rootInput)
					yield* loader.ready
					yield* loader.update("edit", { config: "third" })
					yield* loader.ready
					const afterDirectRefresh = yield* Ref.get(reads)
					assert.strictEqual(afterDirectRefresh, 3)
				}),
			).pipe(
				Effect.provideService(
					Context.Service<{ readonly observed: typeof observed }>(
						"loader/fixture/incremental-reconcile-leaf-1163",
					),
					{ observed },
				),
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

			yield* run({ leaf: fixture("incremental-reconcile-leaf-4007") })(() =>
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
			).pipe(
				Effect.provideService(
					Context.Service<{
						readonly slow: typeof slow
						readonly fast: typeof fast
						readonly release: typeof release
					}>("loader/fixture/incremental-reconcile-leaf-4007"),
					{ slow, fast, release },
				),
			)
		}),
)

it.effect("starts all removals before waiting for dependent cleanup", () =>
	Effect.gen(function* () {
		const first = yield* Deferred.make<void>()
		const second = yield* Deferred.make<void>()

		yield* run({ leaf: fixture("incremental-reconcile-leaf-5323") })(() =>
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
		).pipe(
			Effect.provideService(
				Context.Service<{
					readonly first: typeof first
					readonly second: typeof second
				}>("loader/fixture/incremental-reconcile-leaf-5323"),
				{ first, second },
			),
		)
	}),
)
