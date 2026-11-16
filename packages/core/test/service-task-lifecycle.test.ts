import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Option,
	PubSub,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { CleanupError, type Publication } from "../src/Mount.ts"
import { current, reach, registrySnapshot, run } from "./b1c-utils.ts"

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

const serve = Layer.effect(
	Rpc,
	Effect.gen(function* () {
		const requests = yield* Queue.unbounded<Deferred.Deferred<void>>()
		const stopped = yield* Deferred.make<void>()
		yield* Graft.fork(
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
		return { ping, stopped }
	}),
)

// The stopped signal makes a broken implementation fail without hanging in an uninterruptible finalizer.
const cleanupPing = Effect.fn("cleanupPing")(function* (rpc: Rpc["Service"]) {
	if (yield* Deferred.isDone(rpc.stopped)) return false
	yield* rpc.ping
	return true
})

describe("service task leases", () => {
	it.effect.each(["unmount", "restart"] as const)(
		"keeps queue workers serving consumer cleanup during %s",
		(change) =>
			Effect.gen(function* () {
				const cleaned = yield* Deferred.make<boolean>()
				const provider = yield* Graft.mount(serve, { name: "queue provider" })
				yield* provider.await
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const rpc = yield* Rpc
							yield* rpc.ping
							yield* Effect.addFinalizer(() =>
								Effect.flatMap(cleanupPing(rpc), (value) =>
									Deferred.succeed(cleaned, value),
								),
							)
						}),
					),
					{ name: "queue consumer", requires: [Rpc] },
				)
				yield* consumer.await
				if (change === "unmount") yield* provider.unmount
				else yield* provider.restart
				const answered = yield* Deferred.await(cleaned)
				yield* provider.unmount
				assert.isTrue(answered)
			}).pipe(run),
	)

	it.effect(
		"retains worker-owned resources until the last consumer releases its lease",
		() =>
			Effect.gen(function* () {
				const alive = yield* Ref.make(false)
				const acquired = yield* Deferred.make<void>()
				const seen = yield* Ref.make(false)
				const provider = yield* Graft.mount(
					Layer.effect(
						Resource,
						Effect.gen(function* () {
							yield* Graft.fork(
								Effect.gen(function* () {
									yield* Effect.acquireRelease(Ref.set(alive, true), () =>
										Ref.set(alive, false),
									)
									yield* Deferred.succeed(acquired, undefined)
									return yield* Effect.never
								}),
							)
							yield* Deferred.await(acquired)
							return { isOpen: Ref.get(alive) }
						}),
					),
					{ name: "resource provider" },
				)
				yield* provider.await
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const resource = yield* Resource
							yield* Effect.addFinalizer(() =>
								Effect.flatMap(resource.isOpen, (value) =>
									Ref.set(seen, value),
								),
							)
						}),
					),
					{ name: "resource consumer", requires: [Resource] },
				)
				yield* consumer.await
				yield* provider.unmount
				const duringCleanup = yield* Ref.get(seen)
				const afterDisposal = yield* Ref.get(alive)
				assert.isTrue(duringCleanup)
				assert.isFalse(afterDisposal)
			}).pipe(run),
	)

	it.effect.each(["unmount", "task failure"] as const)(
		"observes failures while draining after %s without stopping healthy workers",
		(reason) =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const initial = yield* Deferred.make<void>()
				const late = yield* Deferred.make<void>()
				const cleanerStarted = yield* Deferred.make<void>()
				const draining = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const cleaned = yield* Ref.make(false)
				const lateFiber = yield* Deferred.make<Fiber.Fiber<never, string>>()
				const publicationScope = yield* Scope.make()
				yield* Effect.addFinalizer(() =>
					Scope.close(publicationScope, Exit.void),
				)
				const publication =
					yield* Deferred.make<
						Exit.Exit<
							Publication<string, Graft.ServiceConflict>,
							Graft.ServiceConflict
						>
					>()
				const provider = yield* Graft.mount(
					Layer.merge(
						serve,
						Layer.effectDiscard(
							Effect.gen(function* () {
								yield* Graft.fork(
									Deferred.await(initial).pipe(
										Effect.andThen(Effect.fail("initial task failure")),
									),
								)
								const fiber = yield* Graft.fork(
									Effect.gen(function* () {
										yield* Deferred.await(late)
										const exit = yield* Effect.exit(
											Scope.provide(
												Graft.publish(Late, "too late"),
												publicationScope,
											),
										)
										yield* Deferred.succeed(publication, exit)
										return yield* Effect.fail("failure during drain")
									}),
								)
								yield* Deferred.succeed(lateFiber, fiber)
								yield* Graft.fork(
									Deferred.succeed(cleanerStarted, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.ensuring(Effect.die("late task cleanup defect")),
									),
								)
								yield* Deferred.await(cleanerStarted)
							}),
						),
					),
					{ name: "draining provider" },
				)
				yield* provider.await
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
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
					),
					{ name: "held consumer", requires: [Rpc] },
				)
				yield* consumer.await
				// Collect every availability frame of the late service from before the attempt.
				const frames = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
				const subscribed = yield* Deferred.make<void>()
				yield* Effect.forkScoped(
					Graft.watch(Late).pipe(
						Stream.tap((value) =>
							Ref.update(frames, Array.append(value)).pipe(
								Effect.andThen(Deferred.succeed(subscribed, undefined)),
							),
						),
						Stream.runDrain,
					),
				)
				yield* Deferred.await(subscribed)
				const closing = yield* Effect.forkScoped(
					reason === "unmount"
						? Effect.exit(provider.unmount)
						: Deferred.succeed(initial, undefined),
				)
				yield* Deferred.await(draining)
				yield* Deferred.succeed(late, undefined)
				const worker = yield* Deferred.await(lateFiber)
				const workerExit = yield* Fiber.await(worker)
				const attempted = yield* Deferred.isDone(publication)
				assert.isTrue(attempted, "The worker must attempt the late publication")
				const attempt = yield* Deferred.await(publication)
				// The publication scope stays open: a draining mount must not settle it as Active.
				const settling = Exit.isSuccess(attempt)
					? yield* Effect.forkScoped(Effect.exit(attempt.value.await))
					: undefined
				const duringDrain = yield* registrySnapshot(runtime)
				assert.isFalse(
					HashMap.has(duringDrain, realmKey("", Late.key)),
					"A service published from a draining mount must never join the graph",
				)
				yield* Deferred.succeed(release, undefined)
				const disposal = yield* Fiber.join(closing)
				if (reason === "unmount") {
					assert.isTrue(Exit.isExit(disposal) && Exit.isFailure(disposal))
					if (Exit.isExit(disposal) && Exit.isFailure(disposal))
						assert.isTrue(
							Array.some(
								disposal.cause.reasons,
								(item) =>
									item._tag === "Fail" &&
									Schema.is(CleanupError)(item.error) &&
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
				if (settling !== undefined && Exit.isSuccess(attempt)) {
					for (let tick = 0; tick < 100; tick++) yield* Effect.yieldNow
					const settled = Option.fromUndefinedOr(settling.pollUnsafe())
					const state = yield* current(attempt.value)
					assert.isTrue(
						Option.exists(settled, Exit.isFailure) || state._tag !== "Active",
						"A publication from a draining mount must not become Active",
					)
					yield* Fiber.interrupt(settling)
				}
				const answered = yield* Ref.get(cleaned)
				assert.isTrue(answered)
				// The publication scope is still open, so a leaked provision would still be there.
				const afterDrain = yield* registrySnapshot(runtime)
				assert.isFalse(
					HashMap.has(afterDrain, realmKey("", Late.key)),
					"A service published from a draining mount must never join the graph",
				)
				const collected = yield* Ref.get(frames)
				assert.isTrue(
					Array.every(collected, (frame) => frame._tag === "None"),
					"A draining mount must never make a service available",
				)
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
