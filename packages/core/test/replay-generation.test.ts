import {
	Array,
	Cause,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	HashMap,
	HashSet,
	Layer,
	Option,
	Queue,
	Ref,
	Schedule,
	Schema,
	Scope,
	Stream,
	String,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import {
	realmKey,
	type GraphNode,
	type Provision,
	type Runtime,
	type Slot,
} from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { reach, run } from "./b1b-utils.ts"

class Dependency extends Context.Service<Dependency, string>()(
	"@graftland/graft/test/replay-generation.test/Dependency",
) {}
class Value extends Context.Service<Value, string>()(
	"@graftland/graft/test/replay-generation.test/Value",
) {}

/** Reads the slot for a service in the root realm, failing if it is already gone. */
const slotOf = (runtime: Runtime, service: string) =>
	Effect.gen(function* () {
		const slots = yield* TxRef.get(runtime.slots)
		return Option.getOrThrow(HashMap.get(slots, realmKey("", service)))
	})

const holders = (slot: Slot) => TxRef.get(slot.holders)

/** The number of mounts currently holding a lease on this provision. */
const consumerCount = (provision: Provision) =>
	Effect.map(TxRef.get(provision.consumers), HashSet.size)

const assertHolders = (slot: Slot, expected: number) =>
	Effect.map(holders(slot), (count) => assert.strictEqual(count, expected))

const assertConsumers = (provision: Provision, expected: number) =>
	Effect.map(consumerCount(provision), (count) =>
		assert.strictEqual(count, expected),
	)

/** The graph node a mount owns, read through the live display table. */
const nodeOf = (runtime: Runtime, id: number) =>
	TxSubscriptionRef.get(runtime.mounts).pipe(
		Effect.map((mounts) => Option.getOrThrow(HashMap.get(mounts, id)).node),
	)

/** Reads a node's own state ref; capture the node before its mount is disposed. */
const stateOf = (node: GraphNode) => TxRef.get(node.state)

const conflictReason = (exit: Exit.Exit<unknown, unknown>) => {
	if (Exit.isSuccess(exit)) return undefined
	const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
	return Schema.is(Graft.ServiceConflict)(error) ? error.reason : undefined
}

/** Yields enough times for a freshly forked fiber to establish its subscription. */
const settleFiber = Effect.forEach(
	Array.makeBy(8, () => undefined),
	() => Effect.yieldNow,
	{ discard: true },
)

/**
 * Wraps the test clock so every retry delay is reported before it registers a
 * sleep. The offer to the unbounded queue is synchronous and the wrapped
 * `sleep` runs next in the same fiber without an async boundary, so an entry
 * taken from the queue means the sleep is registered; the test can advance
 * exactly that delay instead of yielding and hoping.
 */
const observingClock = (sleeps: Queue.Queue<Duration.Duration>) =>
	Effect.map(Clock.Clock, (clock): Clock.Clock => ({
		...clock,
		sleep: (duration) =>
			Duration.toMillis(duration) > 0
				? Effect.andThen(Queue.offer(sleeps, duration), clock.sleep(duration))
				: clock.sleep(duration),
	}))

const dependencyProvider = () =>
	Graft.mount(
		Layer.effectDiscard(
			Effect.gen(function* () {
				const publication = yield* Graft.publish(Dependency, "dep")
				yield* publication.await
			}),
		),
		{ name: "provider" },
	)

const dependencyConsumer = (barrier: {
	readonly entered: Deferred.Deferred<void>
	readonly release: Deferred.Deferred<void>
}) =>
	Graft.mount(
		Layer.effectDiscard(
			Effect.gen(function* () {
				yield* Dependency
				// The real scope finalizer holds teardown open: the generation's
				// consumer lease is not settled until this returns.
				yield* Effect.acquireRelease(Effect.void, () =>
					Deferred.succeed(barrier.entered, undefined).pipe(
						Effect.andThen(Deferred.await(barrier.release)),
					),
				)
			}),
		),
		{ name: "consumer", requires: [Dependency] },
	)

describe("consumer lease generations", () => {
	it.effect(
		"settles an in-flight generation once and keeps the newer holder",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const barrier = {
					entered: yield* Deferred.make<void>(),
					release: yield* Deferred.make<void>(),
				}
				const provider = yield* dependencyProvider()
				yield* provider.await

				const slot = yield* slotOf(runtime, Dependency.key)
				const provisionOption = yield* TxRef.get(slot.provision)
				const provision = Option.getOrThrow(provisionOption)
				yield* assertHolders(slot, 1)

				const first = yield* dependencyConsumer(barrier)
				yield* first.await
				const firstNode = yield* nodeOf(runtime, first.id)
				yield* assertHolders(slot, 2)
				yield* assertConsumers(provision, 1)

				// Start teardown and hold it at the real finalizer.
				const unmounting = yield* Effect.forkScoped(first.unmount)
				yield* Deferred.await(barrier.entered)

				// The withdrawn generation still owns its lease and graph edge.
				const pending = yield* stateOf(firstNode)
				assert.isTrue(pending.live)
				assert.strictEqual(pending.resolution?.provisions.length, 1)
				yield* assertHolders(slot, 2)
				yield* assertConsumers(provision, 1)

				// A new generation leases the same provider while the old one is
				// still unsettled.
				const second = yield* Graft.mount(Layer.effectDiscard(Dependency), {
					name: "newer consumer",
					requires: [Dependency],
				})
				yield* second.await
				yield* assertHolders(slot, 3)
				yield* assertConsumers(provision, 2)

				// Repeated teardown of the same mount must not settle it twice.
				const repeating = yield* Effect.forkScoped(first.unmount)

				// Release the real finalizer: the old generation settles exactly once.
				yield* Deferred.succeed(barrier.release, undefined)
				yield* Fiber.join(unmounting)
				yield* Fiber.join(repeating)
				yield* assertHolders(slot, 2)
				yield* assertConsumers(provision, 1)
				const settled = yield* stateOf(firstNode)
				assert.isFalse(settled.live)
				assert.isUndefined(settled.resolution)
				// The newer generation is untouched by the old teardown.
				yield* second.stable
				const newerProvision = yield* TxRef.get(slot.provision)
				assert.strictEqual(Option.getOrThrow(newerProvision).value, "dep")

				yield* second.unmount
				yield* assertHolders(slot, 1)
				yield* assertConsumers(provision, 0)
				yield* provider.unmount
				yield* assertHolders(slot, 0)
			}).pipe(run),
	)

	it.effect(
		"restart reuses one lease per mount instead of double-counting",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const barrier = {
					entered: yield* Deferred.make<void>(),
					release: yield* Deferred.make<void>(),
				}
				const provider = yield* dependencyProvider()
				yield* provider.await
				const slot = yield* slotOf(runtime, Dependency.key)
				const provisionOption = yield* TxRef.get(slot.provision)
				const provision = Option.getOrThrow(provisionOption)

				const consumer = yield* dependencyConsumer(barrier)
				yield* consumer.await
				yield* assertHolders(slot, 2)

				// A restart tears the old generation down and builds a new one. Its
				// lease is settled once and re-acquired; concurrently it is never held
				// twice for the same mount.
				const restarting = yield* Effect.forkScoped(consumer.restart)
				yield* Deferred.await(barrier.entered)
				yield* assertHolders(slot, 2)
				yield* assertConsumers(provision, 1)

				yield* Deferred.succeed(barrier.release, undefined)
				yield* Fiber.join(restarting)
				yield* reach(consumer, "Active")
				yield* assertHolders(slot, 2)
				yield* assertConsumers(provision, 1)

				yield* consumer.unmount
				yield* assertHolders(slot, 1)
				yield* provider.unmount
				yield* assertHolders(slot, 0)
			}).pipe(run),
	)
})

describe("cycles through a withdrawn generation", () => {
	it.effect(
		"rejects a real publication until the withdrawn lease's finalizer settles",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const barrier = {
					entered: yield* Deferred.make<void>(),
					release: yield* Deferred.make<void>(),
				}
				const publishGate = yield* Deferred.make<void>()
				const firstResult = yield* Deferred.make<Exit.Exit<void, unknown>>()
				const published = yield* Deferred.make<void>()
				const external = yield* Scope.make()

				// The provider requires `Value` optionally, so it watches that slot
				// while still publishing `Dependency`.
				const provider = yield* Graft.mount(
					Layer.effect(Dependency, Effect.succeed("dep")),
					{ name: "provider", requires: [Graft.optional(Value)] },
				)
				yield* provider.await

				// The child is a descendant of the consumer node but lives in an
				// independent scope, so it survives the consumer's teardown and can
				// publish into the window where the old lease is still unsettled.
				const child = Layer.effectDiscard(
					Effect.gen(function* () {
						yield* Deferred.await(publishGate)
						const publication = yield* Graft.publish(Value, "child publication")
						const firstExit = yield* Effect.exit(publication.await)
						yield* Deferred.succeed(firstResult, firstExit)
						yield* reach(publication, "Active")
						yield* Deferred.succeed(published, undefined)
					}),
				)

				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Dependency
							yield* Effect.acquireRelease(Effect.void, () =>
								Deferred.succeed(barrier.entered, undefined).pipe(
									Effect.andThen(Deferred.await(barrier.release)),
								),
							)
							yield* Graft.mount(child, { name: "child publisher" }).pipe(
								Effect.provideService(Scope.Scope, external),
							)
						}),
					),
					{ name: "consumer", requires: [Dependency] },
				)
				yield* consumer.await

				const slot = yield* slotOf(runtime, Dependency.key)
				const provisionOption = yield* TxRef.get(slot.provision)
				const provision = Option.getOrThrow(provisionOption)
				const consumerNode = yield* nodeOf(runtime, consumer.id)
				const unmounting = yield* Effect.forkScoped(consumer.unmount)
				yield* Deferred.await(barrier.entered)

				// The old generation is withdrawn but its consumer lease and
				// dependency edge are still live until the finalizer returns.
				const pending = yield* stateOf(consumerNode)
				assert.isTrue(pending.live)
				assert.strictEqual(pending.resolution?.provisions.length, 1)
				yield* assertConsumers(provision, 1)

				// A newer consumer is a distinct mount with its own node and lease.
				// It is not a new generation of the withdrawn mount, so it exercises
				// a separate token instead of standing in for the old one.
				const newer = yield* Graft.mount(Layer.effectDiscard(Dependency), {
					name: "newer consumer",
					requires: [Dependency],
				})
				yield* newer.await
				yield* assertConsumers(provision, 2)
				// Really unmounting that separate lease completes while the old
				// finalizer is still held.
				yield* newer.unmount
				yield* assertConsumers(provision, 1)

				// Repeated requests to unmount the withdrawn mount share its one
				// teardown and keep waiting on the held finalizer.
				const repeating = yield* Effect.forkScoped(consumer.unmount)
				const repeatingAgain = yield* Effect.forkScoped(consumer.unmount)

				// With the lease unsettled, publishing the watched key would close a
				// cycle through the withdrawn generation.
				yield* Deferred.succeed(publishGate, undefined)
				const rejected = yield* Deferred.await(firstResult)
				assert.strictEqual(conflictReason(rejected), "DependencyCycle")
				// The rejected publication keeps waiting for the edge to clear.
				yield* assertConsumers(provision, 1)

				// The real finalizer completes teardown; that is what settles the
				// lease and drops the graph edge.
				yield* Deferred.succeed(barrier.release, undefined)
				yield* Fiber.join(unmounting)
				yield* Fiber.join(repeating)
				yield* Fiber.join(repeatingAgain)
				const settled = yield* stateOf(consumerNode)
				assert.isFalse(settled.live)
				assert.isUndefined(settled.resolution)

				// Once the lease settles, the same publication is admitted.
				yield* Deferred.await(published)
				const valueSlot = yield* slotOf(runtime, Value.key)
				const value = yield* TxRef.get(valueSlot.provision)
				assert.isTrue(Option.isSome(value))
				if (Option.isSome(value))
					assert.strictEqual(value.value.value, "child publication")

				yield* Scope.close(external, Exit.void)
				yield* provider.unmount
			}).pipe(run),
	)
})

describe("await across state transitions", () => {
	it.effect("retains a queued failure followed immediately by Loading", () =>
		Effect.gen(function* () {
			const proceed = yield* Deferred.make<void>()
			const attempts = yield* Ref.make(0)
			const sleeps = yield* Queue.unbounded<Duration.Duration>()
			const observed = yield* observingClock(sleeps)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
						if (attempt === 1) {
							yield* Deferred.await(proceed)
							return yield* Effect.fail("first build failed")
						}
					}),
				),
				{ name: "queued failure", retry: Schedule.recurs(1) },
			).pipe(Effect.provideService(Clock.Clock, observed))

			// Record the state sequence so the Failed -> Loading adjacency can be
			// asserted after the retry has run.
			const observedStates = yield* Effect.forkScoped(
				mount.state.pipe(
					Stream.takeUntil((state) => state._tag === "Active"),
					Stream.runCollect,
				),
			)

			// Subscribe to await while the first build is still Loading, then let
			// the failure happen. The retry moves the mount back to Loading; await
			// must still observe the queued failure.
			const waiting = yield* Effect.forkScoped(Effect.exit(mount.await))
			yield* settleFiber
			assert.strictEqual(waiting.pollUnsafe(), undefined)

			yield* Deferred.succeed(proceed, undefined)

			yield* reach(mount, "Failed")

			// The failed first build enters the retry loop, whose zero-delay step
			// is floored at 1 ms. Wait until that sleep is registered, then advance
			// exactly it; the reading proves registration, so there is no race.
			const retrySleep = yield* Queue.take(sleeps)
			assert.strictEqual(Duration.toMillis(retrySleep), 1)
			yield* TestClock.adjust(retrySleep)

			const exit = yield* Fiber.join(waiting)

			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.isTrue(
					String.includes("first build failed")(Cause.pretty(exit.cause)),
				)

			// The retry really did follow the failure into a new build.
			yield* reach(mount, "Active")
			const finalAttempts = yield* Ref.get(attempts)
			assert.strictEqual(finalAttempts, 2)

			const collected = yield* Fiber.join(observedStates)
			const tags = Array.map(
				Array.fromIterable(collected),
				(state) => state._tag,
			)
			const failed = tags.indexOf("Failed")
			assert.isAtLeast(failed, 0)
			assert.strictEqual(tags[failed + 1], "Loading")
		}).pipe(run),
	)

	it.effect(
		"reuses await after failure and disposal without replaying a stale cause",
		() =>
			Effect.gen(function* () {
				const mount = yield* Graft.mount(
					Layer.effectDiscard(Effect.fail("stale failure")),
					{ name: "stale failure" },
				)

				const first = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isFailure(first))
				if (Exit.isFailure(first))
					assert.isTrue(
						String.includes("stale failure")(Cause.pretty(first.cause)),
					)

				// Reading the failed generation again yields the same cause, not a
				// rebuilt or replayed one.
				const second = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isFailure(second))
				if (Exit.isFailure(first) && Exit.isFailure(second))
					assert.strictEqual(second.cause, first.cause)

				yield* mount.unmount

				// The same handle's await, reused after disposal, must complete
				// without replaying the cause the earlier generation produced.
				const reused = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isSuccess(reused))

				// A fresh mount's await is likewise clean of the old cause.
				const fresh = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
					name: "fresh",
				})
				yield* fresh.await
				yield* reach(fresh, "Active")
			}).pipe(run),
	)
})
