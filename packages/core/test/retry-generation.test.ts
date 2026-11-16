import {
	Array,
	Cause,
	Deferred,
	Effect,
	Layer,
	PubSub,
	Pull,
	Ref,
	Schedule,
	String,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { current, reach, run } from "./b1c-utils.ts"

/**
 * Advances virtual time in 1ms steps, yielding between steps so the retry
 * sleep is registered before the next adjustment wakes it.
 */
const advanceRetry = Effect.repeat(
	Effect.andThen(Effect.yieldNow, TestClock.adjust("1 millis")),
	Schedule.recurs(4),
)

it.effect(
	"starts a fresh retry budget when a restart interrupts a retry attempt",
	() =>
		Effect.gen(function* () {
			const mode = yield* Ref.make<"old" | "new">("old")
			const retryStarted = yield* Deferred.make<void>()
			const oldAttempts = yield* Ref.make(0)
			const newAttempts = yield* Ref.make(0)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						if ((yield* Ref.get(mode)) === "old") {
							const attempt = yield* Ref.updateAndGet(oldAttempts, (n) => n + 1)
							if (attempt === 1)
								return yield* Effect.fail("old configuration failed")
							yield* Deferred.succeed(retryStarted, undefined)
							return yield* Effect.never
						}
						const attempt = yield* Ref.updateAndGet(newAttempts, (n) => n + 1)
						if (attempt === 1)
							return yield* Effect.fail("new configuration failed once")
					}),
				),
				{ name: "retry generation", retry: Schedule.recurs(1) },
			)
			yield* advanceRetry
			yield* Deferred.await(retryStarted)
			yield* Ref.set(mode, "new")
			yield* mount.restart
			yield* advanceRetry
			yield* reach(mount, "Active")
			const attempts = yield* Ref.get(newAttempts)
			const state = yield* current(mount)
			assert.strictEqual(attempts, 2)
			assert.strictEqual(state._tag, "Active")
		}).pipe(run),
)

it.effect("records retry driver defects racing with a restart", () =>
	Effect.gen(function* () {
		const { runtime } = yield* RuntimeContext
		const mode = yield* Ref.make<"broken" | "fixed">("broken")
		const constructing = yield* Deferred.make<void>()
		const retry = Schedule.fromStep(
			Effect.succeed(() =>
				Effect.die("retry driver defect").pipe(
					Effect.ensuring(Deferred.succeed(constructing, undefined)),
				),
			),
		)
		const mount = yield* Graft.mount(
			Layer.effectDiscard(
				Effect.gen(function* () {
					if ((yield* Ref.get(mode)) === "broken")
						return yield* Effect.fail("initial failure")
				}),
			),
			{ name: "defective retry driver", retry },
		)
		yield* Deferred.await(constructing)
		yield* Ref.set(mode, "fixed")
		yield* mount.restart
		yield* reach(mount, "Active")
		yield* Effect.log("Review retry driver failures")
		const subscription = yield* PubSub.subscribe(runtime.logs)
		const logs = yield* PubSub.takeAll(subscription)
		assert.isTrue(
			Array.some(
				logs,
				({ cause, message }) =>
					String.includes("retry driver defect")(Cause.pretty(cause)) ||
					(Array.isArray(message) &&
						Array.some(
							message,
							(item) =>
								Cause.isCause(item) &&
								String.includes("retry driver defect")(Cause.pretty(item)),
						)),
			),
		)
	}).pipe(run),
)

it.effect(
	"does not replenish the retry budget for an unchanged failing spec",
	() =>
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0)
			const exhausted = yield* Deferred.make<void>()
			const retry = Schedule.fromStep(
				Effect.map(
					Schedule.toStep(Schedule.recurs(2)),
					(step) => (now: number, input: unknown) =>
						step(now, input).pipe(
							Pull.catchDone((last) =>
								Deferred.succeed(exhausted, undefined).pipe(
									Effect.andThen(Cause.done(last)),
								),
							),
						),
				),
			)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Ref.update(attempts, (n) => n + 1).pipe(
						Effect.andThen(Effect.fail("still failing")),
					),
				),
				{ name: "bounded retries", retry },
			)
			yield* advanceRetry
			yield* Deferred.await(exhausted)
			const count = yield* Ref.get(attempts)
			const state = yield* current(mount)
			assert.strictEqual(count, 3)
			assert.strictEqual(state._tag, "Failed")
		}).pipe(run),
)
