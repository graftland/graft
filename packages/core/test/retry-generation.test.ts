import { RuntimeContext } from "../src/internal/runtimeContext"
import { assert, it } from "@effect/vitest"
import {
	Cause,
	Deferred,
	Effect,
	Option,
	PubSub,
	Pull,
	Ref,
	Schedule,
	Schema,
	Stream,
	Array,
	String,
} from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { reach, run } from "./utils.ts"

it.effect(
	"starts a fresh retry budget when configuration changes during a retry attempt",
	() =>
		Effect.gen(function* () {
			const retryStarted = yield* Deferred.make<void>()
			const oldAttempts = yield* Ref.make(0)
			const newAttempts = yield* Ref.make(0)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "retry generation",
					config: Schema.String,
					retry: Schedule.recurs(1),
					apply: (input) =>
						Effect.gen(function* () {
							if (input === "old") {
								const attempt = yield* Ref.updateAndGet(
									oldAttempts,
									(n) => n + 1,
								)
								if (attempt === 1)
									return yield* Effect.fail("old configuration failed")
								yield* Deferred.succeed(retryStarted, undefined)
								return yield* Effect.never
							}
							const attempt = yield* Ref.updateAndGet(newAttempts, (n) => n + 1)
							if (attempt === 1)
								return yield* Effect.fail("new configuration failed once")
						}),
				}),
				"old",
			)
			yield* Deferred.await(retryStarted)
			yield* fork.update("new")
			yield* reach(fork, "Active")
			const attempts = yield* Ref.get(newAttempts)
			const state = yield* Stream.runHead(fork.state)
			assert.strictEqual(attempts, 2)
			assert.strictEqual(Option.getOrThrow(state)._tag, "Active")
		}).pipe(run),
)

it.effect(
	"records retry driver defects racing with configuration changes",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const constructing = yield* Deferred.make<void>()
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "defective retry driver",
					config: Schema.String,
					retry: Schedule.fromStep(
						Effect.succeed(() =>
							Effect.die("retry driver defect").pipe(
								Effect.ensuring(Deferred.succeed(constructing, undefined)),
							),
						),
					),
					apply: (input) =>
						input === "fixed" ? Effect.void : Effect.fail("initial failure"),
				}),
				"broken",
			)
			yield* Deferred.await(constructing)
			yield* fork.update("fixed")
			yield* reach(fork, "Active")
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
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "bounded retries",
					retry,
					apply: () =>
						Ref.update(attempts, (n) => n + 1).pipe(
							Effect.andThen(Effect.fail("still failing")),
						),
				}),
			)
			yield* Deferred.await(exhausted)
			const count = yield* Ref.get(attempts)
			const state = yield* Stream.runHead(fork.state)
			assert.strictEqual(count, 3)
			assert.strictEqual(Option.getOrThrow(state)._tag, "Failed")
		}).pipe(run),
)
