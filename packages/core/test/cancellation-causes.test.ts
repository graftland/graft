import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	PubSub,
	Schema,
	String,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { run } from "./utils.ts"

describe("cancellation causes", () => {
	it.effect(
		"records an apply failure racing with replacement of that plugin",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const replacementStarted = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const replacement = Plugin.make({
					name: "replacement",
					apply: () =>
						Effect.asVoid(Deferred.succeed(replacementStarted, undefined)),
				})
				// The old activation fails after the swap, before it can be interrupted.
				const original = Plugin.make({
					name: "original",
					apply: () =>
						Deferred.await(release).pipe(
							Effect.andThen(Effect.fail("failure during replacement")),
							Effect.uninterruptible,
						),
				})
				const fork = yield* Graft.plugin(original)
				const replacing = yield* Effect.forkChild(
					Graft.replace([[original, replacement]]),
				)
				yield* Effect.tx(
					Effect.gen(function* () {
						const forks = yield* TxSubscriptionRef.get(runtime.forks)
						const entry = Option.getOrThrow(HashMap.get(forks, fork.id))
						const spec = yield* TxRef.get(entry.spec)
						if (spec.plugin !== replacement) return yield* Effect.txRetry
					}),
				)
				yield* Deferred.succeed(release, undefined)
				yield* Deferred.await(replacementStarted)
				const result = yield* Fiber.join(replacing)
				assert.strictEqual(result._tag, "Replaced")
				yield* Effect.log("Review replacement logs")
				const subscription = yield* PubSub.subscribe(runtime.logs)
				const entries = yield* PubSub.takeAll(subscription)
				assert.isTrue(
					Array.some(
						entries,
						({ cause, message }) =>
							String.includes("failure during replacement")(
								Cause.pretty(cause),
							) ||
							(Array.isArray(message) &&
								Array.some(
									message,
									(item) =>
										Cause.isCause(item) &&
										String.includes("failure during replacement")(
											Cause.pretty(item),
										),
								)),
					),
				)
			}).pipe(run),
	)

	for (const mode of ["emit", "parallel", "bail"] as const)
		it.effect(
			`preserves handler cleanup defects when ${mode} is interrupted`,
			() =>
				Effect.gen(function* () {
					const event = Event.make<[], Option.Option<string>>(
						"interrupted-dispatch",
					)
					const entered = yield* Deferred.make<void>()
					yield* Event.on(event, () =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(Effect.die("handler cleanup defect")),
						),
					)
					const dispatch = yield* Effect.forkScoped(
						mode === "emit"
							? Event.emit(event)
							: mode === "parallel"
								? Event.parallel(event)
								: Event.bail(event),
					)
					yield* Deferred.await(entered)
					yield* Fiber.interrupt(dispatch)
					const exit = yield* Fiber.await(dispatch)
					assert.isTrue(
						Exit.isFailure(exit) && Cause.hasDies(exit.cause),
						Exit.isFailure(exit)
							? Cause.pretty(exit.cause)
							: "Dispatch succeeded",
					)
					if (Exit.isFailure(exit))
						assert.include(Cause.pretty(exit.cause), "handler cleanup defect")
				}).pipe(run),
		)

	it.effect(
		"records cleanup defects from an in-place update interrupted by a newer input",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const entered = yield* Deferred.make<void>()
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "interrupted update cleanup",
						config: Schema.String,
						apply: () =>
							Effect.succeed(() =>
								Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(Effect.die("update cleanup defect")),
								),
							),
					}),
					"initial",
				)
				yield* fork.await
				const first = yield* Effect.forkScoped(fork.update("middle"))
				yield* Deferred.await(entered)
				yield* fork.update("latest")
				yield* Fiber.join(first)
				yield* fork.await
				yield* Effect.log("Review update cancellation logs")
				const subscription = yield* PubSub.subscribe(runtime.logs)
				const entries = yield* PubSub.takeAll(subscription)
				assert.isTrue(
					Array.some(
						entries,
						({ cause, message }) =>
							String.includes("update cleanup defect")(Cause.pretty(cause)) ||
							(Array.isArray(message) &&
								Array.some(
									message,
									(item) =>
										Cause.isCause(item) &&
										String.includes("update cleanup defect")(
											Cause.pretty(item),
										),
								)),
					),
				)
			}).pipe(run),
	)
})
