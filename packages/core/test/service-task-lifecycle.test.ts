import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	PubSub,
	Queue,
	Ref,
	Schema,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Fork, Graft, Plugin } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { reach, run } from "./utils.ts"

class Rpc extends Context.Service<
	Rpc,
	{
		readonly ping: Effect.Effect<void>
		readonly stopped: Deferred.Deferred<void>
	}
>()("@graftland/graft/test/service-task-lifecycle.test/Rpc") {}
class Resource extends Context.Service<
	Resource,
	{ readonly isOpen: Effect.Effect<boolean> }
>()("@graftland/graft/test/service-task-lifecycle.test/Resource") {}
class Late extends Context.Service<Late, string>()(
	"@graftland/graft/test/service-task-lifecycle.test/Late",
) {}

const serve = Effect.gen(function* () {
	const requests = yield* Queue.unbounded<Deferred.Deferred<void>>()
	const stopped = yield* Deferred.make<void>()
	yield* Plugin.fork(
		Effect.forever(
			Effect.flatMap(Queue.take(requests), (reply) =>
				Deferred.succeed(reply, undefined),
			),
		).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
	)
	const ping = Effect.gen(function* () {
		const reply = yield* Deferred.make<void>()
		yield* Queue.offer(requests, reply)
		yield* Deferred.await(reply)
	})
	yield* Graft.provide(Rpc, { ping, stopped })
})

// The stopped signal makes a broken implementation fail without hanging in an uninterruptible finalizer.
const cleanupPing = Effect.fn("cleanupPing")(function* (rpc: Rpc["Service"]) {
	if (yield* Deferred.isDone(rpc.stopped)) return false
	yield* rpc.ping
	return true
})

describe("service task leases", () => {
	it.effect(
		"retains worker-owned resources until the last consumer releases its lease",
		() =>
			Effect.gen(function* () {
				const alive = yield* Ref.make(false)
				const acquired = yield* Deferred.make<void>()
				const seen = yield* Ref.make(false)
				const provider = yield* Graft.plugin(
					Plugin.make({
						name: "resource provider",
						apply: () =>
							Effect.gen(function* () {
								yield* Plugin.fork(
									Effect.gen(function* () {
										yield* Effect.acquireRelease(Ref.set(alive, true), () =>
											Ref.set(alive, false),
										)
										yield* Deferred.succeed(acquired, undefined)
										return yield* Effect.never
									}),
								)
								yield* Deferred.await(acquired)
								yield* Graft.provide(Resource, { isOpen: Ref.get(alive) })
							}),
					}),
				)
				yield* provider.await
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "resource consumer",
						inject: [Resource],
						apply: () =>
							Effect.gen(function* () {
								const resource = yield* Resource
								yield* Effect.addFinalizer(() =>
									Effect.flatMap(resource.isOpen, (value) =>
										Ref.set(seen, value),
									),
								)
							}),
					}),
				)
				yield* consumer.await
				yield* provider.dispose
				const duringCleanup = yield* Ref.get(seen)
				const afterDisposal = yield* Ref.get(alive)
				assert.isTrue(duringCleanup)
				assert.isFalse(afterDisposal)
			}).pipe(run),
	)

	it.effect.each(["disposal", "task failure"] as const)(
		"observes failures while draining after %s without stopping healthy workers",
		(reason) =>
			Effect.gen(function* () {
				const initial = yield* Deferred.make<void>()
				const late = yield* Deferred.make<void>()
				const cleanerStarted = yield* Deferred.make<void>()
				const draining = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const cleaned = yield* Ref.make(false)
				const lateFiber = yield* Deferred.make<Fiber.Fiber<never, string>>()
				const publication =
					yield* Deferred.make<Exit.Exit<void, Graft.ServiceConflict>>()
				const provider = yield* Graft.plugin(
					Plugin.make({
						name: "draining provider",
						apply: () =>
							Effect.gen(function* () {
								yield* serve
								yield* Plugin.fork(
									Deferred.await(initial).pipe(
										Effect.andThen(Effect.fail("initial task failure")),
									),
								)
								const fiber = yield* Plugin.fork(
									Effect.gen(function* () {
										yield* Deferred.await(late)
										const exit = yield* Effect.exit(
											Graft.provide(Late, "too late"),
										)
										yield* Deferred.succeed(publication, exit)
										return yield* Effect.fail("failure during drain")
									}),
								)
								yield* Deferred.succeed(lateFiber, fiber)
								yield* Plugin.fork(
									Deferred.succeed(cleanerStarted, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.ensuring(Effect.die("late task cleanup defect")),
									),
								)
								yield* Deferred.await(cleanerStarted)
							}),
					}),
				)
				yield* provider.await
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "held consumer",
						inject: [Rpc],
						apply: () =>
							Effect.gen(function* () {
								const rpc = yield* Rpc
								yield* Effect.addFinalizer(() =>
									Effect.gen(function* () {
										yield* Deferred.succeed(draining, undefined)
										yield* Deferred.await(release)
										const answered = yield* cleanupPing(rpc)
										yield* Ref.set(cleaned, answered)
									}),
								)
							}),
					}),
				)
				yield* consumer.await
				const closing = yield* Effect.forkScoped(
					reason === "disposal"
						? Effect.exit(provider.dispose)
						: Deferred.succeed(initial, undefined),
				)
				yield* Deferred.await(draining)
				yield* Deferred.succeed(late, undefined)
				const worker = yield* Deferred.await(lateFiber)
				const workerExit = yield* Fiber.await(worker)
				// A prematurely stopped worker never attempts publication. Do not wait for its signal in that case.
				const attempted = yield* Deferred.isDone(publication)
				const rejected = attempted
					? yield* Deferred.await(publication)
					: Exit.void
				yield* Deferred.succeed(release, undefined)
				const disposal = yield* Fiber.join(closing)
				if (reason === "disposal") {
					assert.isTrue(Exit.isExit(disposal) && Exit.isFailure(disposal))
					if (Exit.isExit(disposal) && Exit.isFailure(disposal))
						assert.isTrue(
							Array.some(
								disposal.cause.reasons,
								(item) =>
									item._tag === "Fail" &&
									Schema.is(Fork.CleanupError)(item.error) &&
									Array.some(
										item.error.cause.reasons,
										(reason) =>
											reason._tag === "Fail" &&
											reason.error === "failure during drain",
									),
							),
						)
				}
				if (reason === "task failure") yield* reach(provider, "Failed")
				const answered = yield* Ref.get(cleaned)
				assert.isTrue(answered)
				assert.isTrue(attempted)
				assert.isTrue(Exit.isFailure(rejected) && Cause.hasDies(rejected.cause))
				assert.isTrue(Exit.isFailure(workerExit))
				if (Exit.isFailure(workerExit))
					assert.isTrue(
						Array.some(
							workerExit.cause.reasons,
							(item) =>
								item._tag === "Fail" && item.error === "failure during drain",
						),
					)
				if (reason === "task failure") {
					const exit = yield* Effect.exit(provider.await)
					assert.isTrue(Exit.isFailure(exit))
					if (Exit.isFailure(exit)) {
						assert.isTrue(
							Array.some(
								exit.cause.reasons,
								(item) =>
									item._tag === "Fail" && item.error === "initial task failure",
							),
						)
						assert.isTrue(
							Array.some(
								exit.cause.reasons,
								(item) =>
									item._tag === "Fail" && item.error === "failure during drain",
							),
						)
						assert.isTrue(
							Array.some(
								exit.cause.reasons,
								(item) =>
									item._tag === "Die" &&
									item.defect === "late task cleanup defect",
							),
						)
					}
				}
				const { runtime } = yield* RuntimeContext
				const subscription = yield* PubSub.subscribe(runtime.logs)
				const logs = yield* PubSub.takeAll(subscription)
				assert.isTrue(
					Array.some(logs, ({ cause, message }) =>
						Array.some(
							[cause, ...(Array.isArray(message) ? message : [])],
							(value) =>
								Cause.isCause(value) &&
								Array.some(
									value.reasons,
									(item) =>
										item._tag === "Fail" &&
										item.error === "failure during drain",
								),
						),
					),
				)
			}).pipe(run),
	)
})
