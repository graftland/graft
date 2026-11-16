import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	PubSub,
	Schema,
	Stream,
	String,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Mount } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { reach, run } from "./utils.ts"

class Config extends Context.Service<Config, string>()(
	"@graftland/graft/test/cancellation-causes.test/Config",
) {}

describe("cancellation causes", () => {
	it.effect(
		"records an apply failure racing with a replacement of that mount",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const gate = yield* Deferred.make<void>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Deferred.await(gate)
							return yield* Effect.fail("failure during replacement" as const)
						}),
					),
					{ name: "self replacing" },
				)
				// An accepted replacement interrupts the loading build and starts a new one.
				const restarting = yield* Effect.forkScoped(mount.restart)
				yield* Fiber.join(restarting)
				yield* Deferred.succeed(gate, undefined)
				yield* reach(mount, "Failed")
				const exit = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.isTrue(
						String.includes("failure during replacement")(
							Cause.pretty(exit.cause),
						),
					)
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

	it.effect(
		"preserves worker cleanup defects when unmount interrupts the worker",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Graft.fork(
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(Effect.die("handler cleanup defect")),
							),
						).pipe(Effect.asVoid),
					),
					{ name: "interrupted worker" },
				)
				yield* mount.await
				yield* Deferred.await(entered)
				const exit = yield* Effect.exit(mount.unmount)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit)) {
					const error = Cause.squash(exit.cause)
					assert(Schema.is(Mount.CleanupError)(error))
					assert.isTrue(
						Cause.hasDies(error.cause) || Cause.hasInterrupts(error.cause),
					)
					assert.include(Cause.pretty(error.cause), "handler cleanup defect")
				}
			}).pipe(run),
	)

	it.effect(
		"records cleanup defects from a replacement interrupted by a newer input",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const publication = yield* Graft.publish(Config, "initial")
				const middleBuilt = yield* Deferred.make<void>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const value = yield* Config
							if (value === "middle") {
								yield* Deferred.succeed(middleBuilt, undefined)
								yield* Effect.addFinalizer(() =>
									Effect.die("update cleanup defect"),
								)
							}
						}),
					),
					{ name: "replaced input", requires: [Config] },
				)
				yield* mount.await
				yield* publication.set("middle")
				yield* Deferred.await(middleBuilt)
				yield* mount.await
				// Observe the teardown of the interrupted replacement: its cleanup defect
				// must be published as a Failed snapshot, logged, and the newest input still builds.
				const failed = yield* Deferred.make<Mount.MountState>()
				const observing = yield* mount.state.pipe(
					Stream.filter((state) => state._tag === "Failed"),
					Stream.runHead,
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.void,
							onSome: (state) => Deferred.succeed(failed, state),
						}),
					),
					Effect.forkScoped,
				)
				yield* publication.set("latest")
				yield* mount.await
				const exit = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isSuccess(exit))
				const state = yield* Deferred.await(failed)
				assert.strictEqual(state._tag, "Failed")
				if (state._tag === "Failed")
					assert.isTrue(
						Array.some(
							state.cause.reasons,
							(reason) =>
								reason._tag === "Die" &&
								reason.defect === "update cleanup defect",
						),
						Cause.pretty(state.cause),
					)
				yield* Fiber.interrupt(observing)
				const subscription = yield* PubSub.subscribe(runtime.logs)
				const entries = yield* PubSub.takeAll(subscription)
				const releaseLogs = Array.filter(
					entries,
					({ message }) =>
						Array.isArray(message) &&
						Array.contains(
							message as ReadonlyArray<unknown>,
							"Releasing the mount's resources failed",
						),
				)
				assert.strictEqual(releaseLogs.length, 1)
				assert.include(
					Cause.pretty(releaseLogs[0]!.cause),
					"update cleanup defect",
				)
			}).pipe(run),
	)
})
