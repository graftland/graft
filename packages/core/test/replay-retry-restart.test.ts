/**
 * Replayed retry regressions from the 0.6 line: a mount retrying on a non-zero
 * schedule parks on the clock until its delay elapses. A restart or the close
 * of the owning scope must interrupt that wait at once instead of building
 * only after the delay, so both flows run here with the clock frozen.
 */
import {
	Clock,
	Duration,
	Effect,
	Layer,
	Option,
	Queue,
	Ref,
	Schedule,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Graft, Mount } from "../src/index.ts"
import { reach, run } from "./utils.ts"

/** Reads the mount's current state. */
const current = (mount: Mount.Mount) =>
	mount.state.pipe(Stream.runHead, Effect.map(Option.getOrThrow))

const hour = Duration.toMillis(Duration.hours(1))

/**
 * Reports every non-zero sleep before delegating, so a test knows the retry
 * wait is registered rather than guessing at a sequence of yields. A zero
 * sleep is the retry floor and says nothing about the schedule's own delay.
 */
const observeSleeps = Effect.gen(function* () {
	const sleeps = yield* Queue.unbounded<Duration.Duration>()
	const clock = yield* Clock.Clock
	const observed: Clock.Clock = {
		...clock,
		sleep: (duration) =>
			Duration.toMillis(duration) > 0
				? Effect.andThen(Queue.offer(sleeps, duration), clock.sleep(duration))
				: clock.sleep(duration),
	}
	return { sleeps, clock: observed } as const
})

it.effect("restarts out of a one-hour retry wait without waiting for it", () =>
	Effect.gen(function* () {
		const attempts = yield* Ref.make(0)
		const outcome = yield* Ref.make<"fail" | "succeed">("fail")
		const { sleeps, clock } = yield* observeSleeps
		const mount = yield* Graft.mount(
			Layer.effectDiscard(
				Effect.gen(function* () {
					const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
					if ((yield* Ref.get(outcome)) === "fail")
						return yield* Effect.fail(`attempt ${attempt} failed`)
				}),
			),
			{
				name: "restart during retry wait",
				retry: Schedule.spaced("1 hour"),
			},
		).pipe(Effect.provideService(Clock.Clock, clock))

		// The failed attempt publishes Failed and only then registers its wait,
		// so taking the sleep means the retry really parked on the clock.
		const registered = yield* Queue.take(sleeps)
		assert.strictEqual(Duration.toMillis(registered), hour)
		const failed = yield* current(mount)
		assert.strictEqual(failed._tag, "Failed")

		yield* Ref.set(outcome, "succeed")
		// The clock stays frozen: a restart that waited out the delay would hang.
		yield* mount.restart
		yield* reach(mount, "Active")
		const rebuilt = yield* current(mount)
		assert.strictEqual(rebuilt._tag, "Active")
		const rebuiltAttempts = yield* Ref.get(attempts)
		assert.strictEqual(rebuiltAttempts, 2)
		// The rebuilt mount waits for a change, not for time, so it registered no
		// further sleep and the cancelled wait never fires.
		const pending = yield* Queue.size(sleeps)
		assert.strictEqual(pending, 0)
		yield* TestClock.adjust("1 hour")
		const afterWait = yield* Ref.get(attempts)
		assert.strictEqual(afterWait, 2)
		yield* mount.unmount
	}).pipe(run),
)

it.effect(
	"closing the owning scope cancels a pending one-hour retry wait",
	() =>
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0)
			const { sleeps, clock } = yield* observeSleeps
			yield* Effect.scoped(
				Effect.gen(function* () {
					const mount = yield* Graft.mount(
						Layer.effectDiscard(
							Effect.gen(function* () {
								const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
								return yield* Effect.fail(`attempt ${attempt} failed`)
							}),
						),
						{
							name: "scope close during retry wait",
							retry: Schedule.spaced("1 hour"),
						},
					).pipe(Effect.provideService(Clock.Clock, clock))
					const registered = yield* Queue.take(sleeps)
					assert.strictEqual(Duration.toMillis(registered), hour)
					const failed = yield* current(mount)
					assert.strictEqual(failed._tag, "Failed")
					// The scope closes while the retry waits on the frozen clock; a
					// teardown that waited out the delay would hang here.
				}),
			)
			const pending = yield* Queue.size(sleeps)
			assert.strictEqual(pending, 0)
			// The wait was cancelled with the scope, not deferred until its deadline.
			yield* TestClock.adjust("1 hour")
			const afterWait = yield* Ref.get(attempts)
			assert.strictEqual(afterWait, 1)
		}).pipe(run),
)
