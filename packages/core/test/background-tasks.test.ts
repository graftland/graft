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
	Pull,
	Ref,
	Schedule,
	Stream,
	type Scope,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Mount } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { makeJournal, reach, run } from "./utils.ts"

/**
 * Advances virtual time in 1ms steps, yielding between steps so the retry
 * sleep is registered before the next adjustment wakes it.
 */
const advanceRetry = Effect.repeat(
	Effect.andThen(Effect.yieldNow, TestClock.adjust("1 millis")),
	Schedule.recurs(4),
)

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/background-tasks.test/Service",
) {}

type Mounted<E> = Effect.Effect<
	Mount.Mount<E>,
	never,
	Graft.Graft | Scope.Scope
>

describe("supervised background tasks", () => {
	it("retains asynchronous errors in mount contracts even when launch errors are handled", () => {
		const task = Layer.effectDiscard(
			Graft.fork(Effect.fail("task failed" as const)),
		)
		const typed: Mounted<"task failed" | Graft.ServiceConflict> =
			Graft.mount(task)
		assert.isTrue(Effect.isEffect(typed))
		// @ts-expect-error A task's error cannot disappear from its mount contract.
		const quiet: Mounted<Graft.ServiceConflict> = Graft.mount(task)
		assert.isTrue(Effect.isEffect(quiet))
		const caught = Layer.effectDiscard(
			Graft.fork(Effect.fail("task failed" as const)).pipe(
				Effect.catchCause(() => Effect.void),
				Effect.asVoid,
			),
		)
		const stillTyped: Mounted<"task failed" | Graft.ServiceConflict> =
			Graft.mount(caught)
		assert.isTrue(Effect.isEffect(stillTyped))
		// @ts-expect-error Handling the launch effect does not handle the worker.
		const stillNotQuiet: Mounted<Graft.ServiceConflict> = Graft.mount(caught)
		assert.isTrue(Effect.isEffect(stillNotQuiet))
		const service = Layer.effect(
			Service,
			Graft.fork(Effect.fail("service failed" as const)).pipe(
				Effect.as("ready"),
			),
		)
		const serviceTyped: Mounted<"service failed" | Graft.ServiceConflict> =
			Graft.mount(service)
		assert.isTrue(Effect.isEffect(serviceTyped))
		const layer = Layer.effect(
			Service,
			Graft.fork(Effect.fail("layer failed" as const)).pipe(Effect.as("ready")),
		)
		const layerTyped: Mounted<"layer failed" | Graft.ServiceConflict> =
			Graft.mount(layer)
		assert.isTrue(Effect.isEffect(layerTyped))
		const nested = Layer.effectDiscard(
			Graft.fork(Graft.fork(Effect.fail("nested failed" as const))).pipe(
				Effect.asVoid,
			),
		)
		const nestedTyped: Mounted<"nested failed" | Graft.ServiceConflict> =
			Graft.mount(nested)
		assert.isTrue(Effect.isEffect(nestedTyped))
		const missing = Layer.effectDiscard(Graft.fork(Service).pipe(Effect.asVoid))
		type Assert<T extends true> = T
		type ServiceId = "@graftland/graft/test/background-tasks.test/Service"
		type Undeclared =
			ServiceId extends Graft.Required<readonly []> ? true : false
		// @ts-expect-error A background task still requires declared dependencies.
		const undeclared: Assert<Undeclared> = true
		assert.isTrue(undeclared)
		const missingMount = Graft.mount(missing, { requires: [Service] })
		assert.isTrue(Effect.isEffect(missingMount))
	})

	it.effect(
		"fails an active mount and releases its resources after a worker fails",
		() =>
			Effect.gen(function* () {
				const fail = yield* Deferred.make<void>()
				const journal = yield* makeJournal
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => journal.record("released"))
							yield* Graft.fork(
								Deferred.await(fail).pipe(
									Effect.andThen(Effect.fail("worker failed")),
								),
							)
						}),
					),
					{ name: "worker owner" },
				)
				yield* mount.await
				yield* Deferred.succeed(fail, undefined)
				yield* reach(mount, "Failed")
				const exit = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.deepStrictEqual(
						Cause.findErrorOption(exit.cause),
						Option.some("worker failed"),
					)
				yield* journal.expect(["released"])
			}).pipe(run),
	)

	it.effect(
		"interrupts loading apply when a worker fails before startup finishes",
		() =>
			Effect.gen(function* () {
				const stopped = yield* Ref.make(false)
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Graft.fork(Effect.fail("early failure")).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(Ref.set(stopped, true)),
						),
					),
					{ name: "loading owner" },
				)
				yield* reach(mount, "Failed")
				const cleaned = yield* Ref.get(stopped)
				assert.isTrue(cleaned)
			}).pipe(run),
	)

	it.effect(
		"combines the initial failure with sibling cancellation defects",
		() =>
			Effect.gen(function* () {
				const fail = yield* Deferred.make<void>()
				const started = yield* Deferred.make<void>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Graft.fork(
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(Effect.die("worker cleanup defect")),
								),
							)
							yield* Graft.fork(
								Deferred.await(fail).pipe(
									Effect.andThen(Effect.fail("initial failure")),
								),
							)
						}),
					),
					{ name: "two workers" },
				)
				yield* mount.await
				yield* Deferred.await(started)
				yield* Deferred.succeed(fail, undefined)
				yield* reach(mount, "Failed")
				const exit = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit)) {
					assert.deepStrictEqual(
						Cause.findErrorOption(exit.cause),
						Option.some("initial failure"),
					)
					assert.isTrue(
						Array.some(
							exit.cause.reasons,
							(reason) =>
								reason._tag === "Die" &&
								reason.defect === "worker cleanup defect",
						),
					)
					assert.isTrue(Cause.hasInterrupts(exit.cause))
				}
			}).pipe(run),
	)

	it.effect(
		"bounds retries of background failures with the mount schedule",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0)
				const exhausted = yield* Deferred.make<void>()
				const retry = Schedule.fromStep(
					Effect.map(
						Schedule.toStep(Schedule.recurs(1)),
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
						Effect.gen(function* () {
							yield* Ref.update(attempts, (n) => n + 1)
							yield* Graft.fork(Effect.fail("task failed"))
						}),
					),
					{ name: "retrying workers", retry },
				)
				yield* advanceRetry
				yield* Deferred.await(exhausted)
				const count = yield* Ref.get(attempts)
				const snapshot = yield* Stream.runHead(mount.state)
				assert.strictEqual(count, 2)
				assert.strictEqual(Option.getOrThrow(snapshot)._tag, "Failed")
			}).pipe(run),
	)

	it.effect(
		"ignores pure worker interruption while keeping the activation alive",
		() =>
			Effect.gen(function* () {
				const worker = yield* Deferred.make<Fiber.Fiber<never>>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const fiber = yield* Graft.fork(Effect.interrupt)
							yield* Deferred.succeed(worker, fiber)
						}),
					),
					{ name: "cancelled worker" },
				)
				const fiber = yield* Deferred.await(worker)
				yield* Fiber.await(fiber)
				yield* mount.await
				const snapshot = yield* Stream.runHead(mount.state)
				assert.strictEqual(Option.getOrThrow(snapshot)._tag, "Active")
			}).pipe(run),
	)

	it.effect(
		"finishes worker cancellation before releasing activation resources",
		() =>
			Effect.gen(function* () {
				const live = yield* Ref.make(true)
				const cleaning = yield* Deferred.make<void>()
				const finish = yield* Deferred.make<void>()
				const started = yield* Deferred.make<void>()
				const journal = yield* makeJournal
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => Ref.set(live, false))
							yield* Graft.fork(
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(
										Effect.gen(function* () {
											yield* Deferred.succeed(cleaning, undefined)
											yield* Deferred.await(finish)
											const alive = yield* Ref.get(live)
											yield* journal.record(
												alive ? "live" : "released too early",
											)
										}),
									),
								),
							)
						}),
					),
					{ name: "resource owner" },
				)
				yield* mount.await
				yield* Deferred.await(started)
				const closing = yield* Effect.forkScoped(mount.unmount)
				yield* Deferred.await(cleaning)
				const alive = yield* Ref.get(live)
				assert.isTrue(alive)
				yield* Deferred.succeed(finish, undefined)
				yield* Fiber.join(closing)
				yield* journal.expect(["live"])
				const after = yield* Ref.get(live)
				assert.isFalse(after)
			}).pipe(run),
	)

	it.effect(
		"preserves worker cleanup defects when unmounting wins the race",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Graft.fork(
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(Effect.die("disposed worker defect")),
							),
						).pipe(Effect.asVoid),
					),
					{ name: "disposed worker" },
				)
				yield* mount.await
				yield* Deferred.await(started)
				const cleanup = yield* Effect.exit(mount.unmount)
				assert.isTrue(Exit.isFailure(cleanup))
				yield* Effect.log("Review task shutdown failures")
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
									(reason) =>
										reason._tag === "Die" &&
										reason.defect === "disposed worker defect",
								),
						),
					),
				)
			}).pipe(run),
	)

	it.effect(
		"passes a background failure to activation resource finalizers",
		() =>
			Effect.gen(function* () {
				const observed = yield* Deferred.make<Exit.Exit<unknown, unknown>>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Effect.addFinalizer((exit) =>
								Deferred.succeed(observed, exit),
							)
							yield* Graft.fork(Effect.fail("resource owner failed"))
						}),
					),
					{ name: "finalizer context" },
				)
				yield* reach(mount, "Failed")
				const exit = yield* Deferred.await(observed)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.deepStrictEqual(
						Cause.findErrorOption(exit.cause),
						Option.some("resource owner failed"),
					)
			}).pipe(run),
	)
	it.effect(
		"owns task resources independently of a shorter-lived launching scope",
		() =>
			Effect.gen(function* () {
				const acquired = yield* Deferred.make<void>()
				const finish = yield* Deferred.make<void>()
				const released = yield* Ref.make(false)
				const worker = yield* Deferred.make<Fiber.Fiber<void>>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const fiber = yield* Graft.fork(
								Effect.gen(function* () {
									yield* Effect.acquireRelease(
										Deferred.succeed(acquired, undefined),
										() => Ref.set(released, true),
									)
									yield* Deferred.await(finish)
								}),
							).pipe(Effect.scoped)
							yield* Deferred.succeed(worker, fiber)
						}),
					),
					{ name: "scoped launcher" },
				)
				yield* mount.await
				yield* Deferred.await(acquired)
				const early = yield* Ref.get(released)
				assert.isFalse(early)
				yield* Deferred.succeed(finish, undefined)
				const fiber = yield* Deferred.await(worker)
				yield* Fiber.join(fiber)
				const after = yield* Ref.get(released)
				assert.isTrue(after)
				const snapshot = yield* Stream.runHead(mount.state)
				assert.strictEqual(Option.getOrThrow(snapshot)._tag, "Active")
			}).pipe(run),
	)

	it.effect("supervises defects from a task's scoped finalizers", () =>
		Effect.gen(function* () {
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Graft.fork(
						Effect.acquireRelease(Effect.void, () =>
							Effect.die("scoped worker cleanup failed"),
						),
					).pipe(Effect.asVoid),
				),
				{ name: "task finalizer" },
			)
			yield* reach(mount, "Failed")
			const exit = yield* Effect.exit(mount.await)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.isTrue(
					Array.some(
						exit.cause.reasons,
						(reason) =>
							reason._tag === "Die" &&
							reason.defect === "scoped worker cleanup failed",
					),
				)
		}).pipe(run),
	)
})
