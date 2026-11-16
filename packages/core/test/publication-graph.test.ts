import {
	Cause,
	Context,
	Deferred,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
	TxRef,
	type Scope,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { publishValue } from "../src/internal/publication.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import * as Mount from "../src/Mount.ts"
import {
	activeSnapshot,
	makeJournal,
	reach,
	registrySnapshot,
	run,
} from "./b1b-utils.ts"

/**
 * Advances virtual time in 1ms steps, yielding between steps so the retry
 * sleep is registered before the next adjustment wakes it.
 */
const advanceRetry = Effect.repeat(
	Effect.andThen(Effect.yieldNow, TestClock.adjust("1 millis")),
	Schedule.recurs(4),
)

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
const expectCycle = <E>(mount: {
	readonly id: number
	readonly state: Stream.Stream<Mount.MountState<E>>
}) =>
	Effect.gen(function* () {
		yield* reach(mount, "Failed")
		const snapshot = yield* Stream.runHead(mount.state)
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
				const loaded =
					yield* Deferred.make<Mount.Mount<Graft.ServiceConflict>>()
				const journal = yield* makeJournal
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Effect.acquireRelease(
								journal.record("parent started"),
								() => journal.record("parent stopped"),
							)
							const child = yield* Graft.mount(Layer.succeed(Target, "child"), {
								name: "child provider",
							})
							yield* Deferred.succeed(loaded, child)
						}),
					),
					{ name: "watching parent", requires: [Target] },
				)
				yield* parent.await
				const child = yield* Deferred.await(loaded)
				yield* expectCycle(child)
				yield* reach(parent, "Active")
				const { runtime } = yield* RuntimeContext
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
				const owner = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* journal.record("watcher started")
							yield* publishValue(First.key, "first")
						}),
					),
					{ name: "watcher", requires: [Target] },
				)
				yield* owner.await
				const publisher = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Ref.update(attempts, (n) => n + 1)
							yield* publishValue(Target.key, "published")
						}),
					),
					{
						name: "publisher",
						retry: Schedule.recurs(3),
						requires: [First],
					},
				)
				yield* expectCycle(publisher)
				// An unrelated graph change must not make the failed mount retry against its cleaned-up graph.
				const unrelated = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
					name: "unrelated",
				})
				yield* unrelated.await
				yield* unrelated.unmount
				const before = yield* Ref.get(attempts)
				assert.strictEqual(before, 1)
				yield* journal.expect(["watcher started"])
				// Dropping the watcher's dependency breaks the cycle; an independent provider can publish.
				yield* owner.unmount
				yield* Effect.flatMap(
					Graft.mount(Layer.succeed(First, "first"), {
						name: "independent provider",
					}),
					(mount) => mount.await,
				)
				yield* reach(publisher, "Active")
				const after = yield* Ref.get(attempts)
				assert.strictEqual(after, 2)
			}).pipe(ambient),
	)

	it.effect(
		"reaches a fixed point through consumers and their descendants",
		() =>
			Effect.gen(function* () {
				const end = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const published = yield* Graft.mount(
								Layer.succeed(Target, "target"),
								{ name: "end publication" },
							)
							yield* published.await
						}),
					),
					{ name: "end", requires: [Second] },
				)
				yield* reach(end, "Pending")
				const middle = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const child = yield* Graft.mount(
								Layer.succeed(Second, "second"),
								{ name: "middle child" },
							)
							yield* child.await
						}),
					),
					{ name: "middle", requires: [First] },
				)
				yield* reach(middle, "Pending")
				const watcher = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const published = yield* Graft.mount(
								Layer.succeed(First, "first"),
								{ name: "watcher publication" },
							)
							yield* published.await
						}),
					),
					{ name: "watcher", requires: [Graft.optional(Target)] },
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
				const consumer = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
					name: "pending",
					requires: [Target],
				})
				yield* reach(consumer, "Pending")
				const { runtime } = yield* RuntimeContext
				const active = yield* activeSnapshot(runtime)
				assert.isFalse(HashMap.has(active, consumer.id))
				const provider = yield* Graft.mount(Layer.succeed(Target, "target"), {
					name: "provider",
				})
				yield* provider.await
				yield* reach(consumer, "Active")
			}).pipe(run),
	)

	it.effect("does not connect watchers across realms", () =>
		Effect.gen(function* () {
			const parent = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const child = yield* Graft.mount(
							Layer.succeed(Target, "isolated"),
							{ name: "child", isolate: [Target] },
						)
						yield* child.await
					}),
				),
				{ name: "parent", requires: [Target] },
			)
			yield* reach(parent, "Active")
		}).pipe(ambient),
	)

	it.effect(
		"clears graph membership and deduplicates leases when an activation stops",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const provider = yield* Graft.mount(Layer.succeed(Target, "target"), {
					name: "provider",
				})
				yield* provider.await
				const consumer = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
					name: "consumer",
					requires: [Target, Target],
				})
				yield* consumer.await
				const registry = yield* registrySnapshot(runtime)
				const provision = Option.getOrThrow(
					HashMap.get(registry, realmKey("", Target.key)),
				)
				const leased = yield* TxRef.get(provision.consumers)
				assert.deepStrictEqual(leased, HashSet.make(consumer.id))
				yield* consumer.unmount
				yield* provider.unmount
				const active = yield* activeSnapshot(runtime)
				const remaining = yield* TxRef.get(provision.consumers)
				assert.strictEqual(HashMap.size(active), 0)
				assert.strictEqual(HashSet.size(remaining), 0)
			}).pipe(run),
	)

	it.effect(
		"preserves a parent's retry policy when it propagates a child's rejected publication",
		() =>
			Effect.gen(function* () {
				const retried = yield* Deferred.make<void>()
				const attempts = yield* Ref.make(0)
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
							if (attempt === 2) yield* Deferred.succeed(retried, undefined)
							const child = yield* Graft.mount(Layer.succeed(Target, "child"), {
								name: "child",
							})
							yield* child.await
						}),
					),
					{
						name: "retrying parent",
						requires: [Target],
						retry: Schedule.recurs(1),
					},
				)
				yield* advanceRetry
				yield* Deferred.await(retried)
				yield* reach(parent, "Failed")
				const count = yield* Ref.get(attempts)
				assert.strictEqual(count, 2)
			}).pipe(ambient),
	)
})
