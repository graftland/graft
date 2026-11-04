import { registrySnapshot, activeSnapshot } from "./utils.ts"
import { assert, describe, it } from "@effect/vitest"
import type { Scope } from "effect"
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	HashMap,
	HashSet,
	Layer,
	Option,
	Ref,
	Schema,
	Schedule,
	Stream,
	TxRef,
} from "effect"
import { Graft, Plugin, type Fork } from "../src/index.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { makeJournal, reach, run } from "./utils.ts"

class Target extends Context.Service<Target, string>()(
	"@graftland/graft/test/publication-graph.test/Target",
) {}
class First extends Context.Service<First, string>()(
	"@graftland/graft/test/publication-graph.test/First",
) {}
class Second extends Context.Service<Second, string>()(
	"@graftland/graft/test/publication-graph.test/Second",
) {}
const ambient = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.fresh(
				Graft.layer.pipe(Layer.provide(Layer.succeed(Target, "ambient"))),
			),
		),
	)
const expectCycle = (fork: Fork.Fork) =>
	Effect.gen(function* () {
		yield* reach(fork, "Failed")
		const snapshot = yield* Stream.runHead(fork.state)
		const state = Option.getOrThrow(snapshot)
		assert.strictEqual(state._tag, "Failed")
		if (state._tag !== "Failed") return
		const error = Option.getOrThrow(Cause.findErrorOption(state.cause))
		assert.isTrue(Schema.is(Graft.ServiceConflict)(error))
		if (Schema.is(Graft.ServiceConflict)(error))
			assert.strictEqual(error.reason, "DependencyCycle")
	})

describe("publication dependency graph", () => {
	it.effect(
		"keeps the parent active when its child's publication is rejected",
		() =>
			Effect.gen(function* () {
				const loaded = yield* Deferred.make<Fork.Fork>()
				const journal = yield* makeJournal
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "watching parent",
						inject: [Target],
						apply: () =>
							Effect.gen(function* () {
								yield* Effect.acquireRelease(
									journal.record("parent started"),
									() => journal.record("parent stopped"),
								)
								const child = yield* Graft.plugin(
									Plugin.service(Target, Effect.succeed("child"), {
										name: "child provider",
									}),
								)
								yield* Deferred.succeed(loaded, child)
							}),
					}),
				)
				yield* parent.await
				const child = yield* Deferred.await(loaded)
				yield* expectCycle(child)
				yield* reach(parent, "Active")
				const { runtime } = yield* Graft.Graft
				const registry = yield* registrySnapshot(runtime)
				assert.isFalse(HashMap.has(registry, realmKey("", Target.key)))
				yield* journal.expect(["parent started"])
			}).pipe(ambient),
	)

	it.effect(
		"keeps a rejected publisher failed until the other endpoint drops its dependency",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const attempts = yield* Ref.make(0)
				const watcher = Plugin.make({
					name: "watcher",
					inject: [Target],
					apply: () =>
						Effect.gen(function* () {
							yield* journal.record("watcher started")
							yield* Graft.provide(First, "first")
						}),
				})
				const changed = Plugin.service(First, Effect.succeed("first"), {
					name: "independent provider",
				})
				const owner = yield* Graft.plugin(watcher)
				yield* owner.await
				const publisher = yield* Graft.plugin(
					Plugin.make({
						name: "publisher",
						retry: Schedule.recurs(3),
						inject: [First],
						apply: () =>
							Ref.update(attempts, (n) => n + 1).pipe(
								Effect.andThen(Graft.provide(Target, "published")),
							),
					}),
				)
				yield* expectCycle(publisher)
				// An unrelated graph change must not make the failed fork retry against its cleaned-up graph.
				const unrelated = yield* Graft.plugin(
					Plugin.make({ name: "unrelated", apply: () => Effect.void }),
				)
				yield* unrelated.await
				yield* unrelated.dispose
				const before = yield* Ref.get(attempts)
				assert.strictEqual(before, 1)
				yield* journal.expect(["watcher started"])
				yield* Graft.replace([[watcher, changed]])
				yield* reach(publisher, "Active")
				const after = yield* Ref.get(attempts)
				assert.strictEqual(after, 2)
			}).pipe(ambient),
	)

	it.effect(
		"reaches a fixed point through consumers and their descendants",
		() =>
			Effect.gen(function* () {
				const end = yield* Graft.plugin(
					Plugin.make({
						name: "end",
						inject: [Second],
						apply: () => Graft.provide(Target, "target"),
					}),
				)
				yield* reach(end, "Pending")
				const middle = yield* Graft.plugin(
					Plugin.make({
						name: "middle",
						inject: [First],
						apply: () =>
							Effect.gen(function* () {
								const child = yield* Graft.plugin(
									Plugin.service(Second, Effect.succeed("second"), {
										name: "middle child",
									}),
								)
								yield* child.await
							}),
					}),
				)
				yield* reach(middle, "Pending")
				const watcher = yield* Graft.plugin(
					Plugin.make({
						name: "watcher",
						inject: [Plugin.optional(Target)],
						apply: () => Graft.provide(First, "first"),
					}),
				)
				yield* watcher.await
				yield* expectCycle(end)
				yield* reach(watcher, "Active")
				yield* reach(middle, "Active")
			}).pipe(run),
	)

	it.effect(
		"does not treat required pending dependencies as restart watchers",
		() =>
			Effect.gen(function* () {
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "pending",
						inject: [Target],
						apply: () => Effect.void,
					}),
				)
				yield* reach(consumer, "Pending")
				const { runtime } = yield* Graft.Graft
				const active = yield* activeSnapshot(runtime)
				assert.isFalse(HashMap.has(active, consumer.id))
				const provider = yield* Graft.plugin(
					Plugin.service(Target, Effect.succeed("target"), {
						name: "provider",
					}),
				)
				yield* provider.await
				yield* reach(consumer, "Active")
			}).pipe(run),
	)

	it.effect("does not connect watchers across realms", () =>
		Effect.gen(function* () {
			const parent = yield* Graft.plugin(
				Plugin.make({
					name: "parent",
					inject: [Target],
					apply: () =>
						Effect.gen(function* () {
							const child = yield* Graft.plugin(
								Plugin.service(Target, Effect.succeed("isolated"), {
									name: "child",
								}),
								undefined,
								{ isolate: [Target] },
							)
							yield* child.await
						}),
				}),
			)
			yield* reach(parent, "Active")
		}).pipe(ambient),
	)

	it.effect(
		"clears graph membership and deduplicates leases when an activation stops",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* Graft.Graft
				const provider = yield* Graft.plugin(
					Plugin.service(Target, Effect.succeed("target"), {
						name: "provider",
					}),
				)
				yield* provider.await
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "consumer",
						inject: [Target, Target],
						apply: () => Effect.void,
					}),
				)
				yield* consumer.await
				const registry = yield* registrySnapshot(runtime)
				const provision = Option.getOrThrow(
					HashMap.get(registry, realmKey("", Target.key)),
				)
				const leased = yield* TxRef.get(provision.consumers)
				assert.deepStrictEqual(leased, HashSet.make(consumer.id))
				yield* consumer.dispose
				yield* provider.dispose
				const active = yield* activeSnapshot(runtime)
				const remaining = yield* TxRef.get(provision.consumers)
				assert.strictEqual(HashMap.size(active), 0)
				assert.strictEqual(HashSet.size(remaining), 0)
			}).pipe(run),
	)
	it.effect(
		"rejects publication from an activation already invalidated in the same transaction",
		() =>
			Effect.gen(function* () {
				const first =
					yield* Deferred.make<Effect.Effect<void, Graft.ServiceConflict>>()
				const second =
					yield* Deferred.make<Effect.Effect<void, Graft.ServiceConflict>>()
				const left = yield* Graft.plugin(
					Plugin.make({
						name: "left",
						inject: [Plugin.optional(First)],
						apply: () =>
							Effect.gen(function* () {
								const context = yield* Effect.context<Graft.Graft>()
								yield* Deferred.succeed(
									first,
									Graft.provide(Target, "left").pipe(
										Effect.provideContext(context),
									),
								)
							}),
					}),
				)
				const right = yield* Graft.plugin(
					Plugin.make({
						name: "right",
						inject: [Plugin.optional(Target)],
						apply: () =>
							Effect.gen(function* () {
								const context = yield* Effect.context<Graft.Graft>()
								yield* Deferred.succeed(
									second,
									Graft.provide(First, "right").pipe(
										Effect.provideContext(context),
									),
								)
							}),
					}),
				)
				yield* left.await
				yield* right.await
				const publishLeft = yield* Deferred.await(first)
				const publishRight = yield* Deferred.await(second)
				// The transaction exposes the first publication to the second check before either supervisor runs.
				const result = yield* Effect.exit(
					Effect.tx(Effect.andThen(publishLeft, publishRight)),
				)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) {
					const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
					assert.strictEqual(error.reason, "Invalidated")
				}
				const { runtime } = yield* Graft.Graft
				const registry = yield* registrySnapshot(runtime)
				assert.strictEqual(HashMap.size(registry), 0)
			}).pipe(run),
	)
	it.effect(
		"preserves a parent's retry policy when it propagates a child's rejected publication",
		() =>
			Effect.gen(function* () {
				const retried = yield* Deferred.make<void>()
				const attempts = yield* Ref.make(0)
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "retrying parent",
						inject: [Target],
						retry: Schedule.recurs(1),
						apply: () =>
							Effect.gen(function* () {
								const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
								if (attempt === 2) yield* Deferred.succeed(retried, undefined)
								const child = yield* Graft.plugin(
									Plugin.service(Target, Effect.succeed("child"), {
										name: "child",
									}),
								)
								yield* child.await
							}),
					}),
				)
				yield* Deferred.await(retried)
				yield* reach(parent, "Failed")
				const count = yield* Ref.get(attempts)
				assert.strictEqual(count, 2)
			}).pipe(ambient),
	)
})
