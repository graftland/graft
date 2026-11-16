import {
	Array,
	Clock,
	Deferred,
	Duration,
	Effect,
	Layer,
	Queue,
	Ref,
	Schedule,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { reach, run } from "./b1c-utils.ts"

/** Builds a layer that counts every attempt and always fails with this message. */
const failingLayer = (attempts: Ref.Ref<number>, failure: string) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			yield* Ref.update(attempts, (count) => count + 1)
			return yield* Effect.fail(failure)
		}),
	)

/** Lets already scheduled work run without depending on wall time. */
const settle = Effect.repeat(Effect.yieldNow, Schedule.recurs(8))

/**
 * Wraps the test clock so every retry delay is reported before it registers a
 * sleep. Offering to the unbounded queue is synchronous and the wrapped
 * `sleep` follows in the same fiber without an async boundary, so taking a
 * duration proves that sleep is registered: the test can then advance exactly
 * that delay instead of yielding a guessed number of times and hoping.
 */
const observingClock = (sleeps: Queue.Queue<Duration.Duration>) =>
	Effect.map(Clock.Clock, (clock): Clock.Clock => ({
		...clock,
		sleep: (duration) =>
			Duration.toMillis(duration) > 0
				? Effect.andThen(Queue.offer(sleeps, duration), clock.sleep(duration))
				: clock.sleep(duration),
	}))

it.effect("attempts a failed mount exactly once without a retry schedule", () =>
	Effect.gen(function* () {
		const attempts = yield* Ref.make(0)
		const mount = yield* Graft.mount(
			failingLayer(attempts, "startup failure"),
			{
				name: "no retry",
			},
		)
		yield* reach(mount, "Failed")
		yield* settle
		const afterFailure = yield* Ref.get(attempts)
		assert.strictEqual(afterFailure, 1)
		// No schedule means no retry even when time passes.
		yield* TestClock.adjust("1 hour")
		yield* settle
		const afterWaiting = yield* Ref.get(attempts)
		assert.strictEqual(afterWaiting, 1)
		yield* mount.unmount
	}).pipe(run),
)

it.effect(
	"spaces exponential retries over time and cancels the pending one",
	() =>
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0)
			const times = yield* Ref.make<ReadonlyArray<number>>([])
			const first = yield* Deferred.make<void>()
			const second = yield* Deferred.make<void>()
			const third = yield* Deferred.make<void>()
			const sleeps = yield* Queue.unbounded<Duration.Duration>()
			const observed = yield* observingClock(sleeps)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
						const now = yield* Clock.currentTimeMillis
						yield* Ref.update(times, Array.append(now))
						if (attempt === 1) yield* Deferred.succeed(first, undefined)
						if (attempt === 2) yield* Deferred.succeed(second, undefined)
						if (attempt === 3) yield* Deferred.succeed(third, undefined)
						return yield* Effect.fail("startup failure")
					}),
				),
				{
					name: "exponential retry",
					retry: Schedule.exponential("100 millis"),
				},
			).pipe(Effect.provideService(Clock.Clock, observed))

			// The first attempt runs at once and fails, then the retry registers
			// its 100ms sleep. Advancing that exact delay is race free.
			yield* Deferred.await(first)
			const firstSleep = yield* Queue.take(sleeps)
			assert.strictEqual(Duration.toMillis(firstSleep), 100)
			yield* TestClock.adjust(firstSleep)
			yield* Deferred.await(second)

			// The next wait doubles to 200ms; no millisecond floor is added on
			// top of the schedule's own delay.
			const secondSleep = yield* Queue.take(sleeps)
			assert.strictEqual(Duration.toMillis(secondSleep), 200)
			yield* TestClock.adjust(secondSleep)
			yield* Deferred.await(third)
			const observedTimes = yield* Ref.get(times)
			assert.deepStrictEqual(observedTimes, [0, 100, 300])

			// The 400ms retry is registered and pending: unmounting must drop it
			// instead of waiting out the delay.
			const pendingSleep = yield* Queue.take(sleeps)
			assert.strictEqual(Duration.toMillis(pendingSleep), 400)
			yield* mount.unmount
			yield* TestClock.adjust("1 hour")
			yield* settle
			const afterUnmount = yield* Ref.get(attempts)
			assert.strictEqual(afterUnmount, 3)
		}).pipe(run),
)

it.effect(
	"bounds an immediate infinite schedule to one attempt per millisecond",
	() =>
		Effect.gen(function* () {
			// Every zero-delay retry is floored at one millisecond, so an immediate
			// infinite schedule cannot rebuild the mount back to back.
			const attempts = yield* Ref.make(0)
			const first = yield* Deferred.make<void>()
			const second = yield* Deferred.make<void>()
			const third = yield* Deferred.make<void>()
			const sleeps = yield* Queue.unbounded<Duration.Duration>()
			const observed = yield* observingClock(sleeps)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
						if (attempt === 1) yield* Deferred.succeed(first, undefined)
						if (attempt === 2) yield* Deferred.succeed(second, undefined)
						if (attempt === 3) yield* Deferred.succeed(third, undefined)
						return yield* Effect.fail("startup failure")
					}),
				),
				{ name: "immediate retry", retry: Schedule.forever },
			).pipe(Effect.provideService(Clock.Clock, observed))

			// With the clock frozen the mount fails once and then registers its
			// 1ms floor as a sleep. Only advancing that delay admits the next try.
			yield* Deferred.await(first)
			const frozen = yield* Ref.get(attempts)
			assert.strictEqual(frozen, 1)

			const firstSleep = yield* Queue.take(sleeps)
			assert.strictEqual(Duration.toMillis(firstSleep), 1)
			yield* TestClock.adjust(firstSleep)
			yield* Deferred.await(second)
			const once = yield* Ref.get(attempts)
			assert.strictEqual(once, 2)

			const secondSleep = yield* Queue.take(sleeps)
			assert.strictEqual(Duration.toMillis(secondSleep), 1)
			yield* TestClock.adjust(secondSleep)
			yield* Deferred.await(third)
			const twice = yield* Ref.get(attempts)
			assert.strictEqual(twice, 3)

			// Unmount stops the bounded retry at once; advancing time does not
			// restore it.
			const pendingSleep = yield* Queue.take(sleeps)
			assert.strictEqual(Duration.toMillis(pendingSleep), 1)
			yield* mount.unmount
			yield* TestClock.adjust("1 hour")
			yield* settle
			const stopped = yield* Ref.get(attempts)
			assert.strictEqual(stopped, 3)
		}).pipe(run),
)
