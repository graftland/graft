import { RuntimeContext } from "../src/internal/runtimeContext"
import { assert, describe, it } from "@effect/vitest"
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
	Pull,
	PubSub,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { Graft, Plugin } from "../src/index.ts"
import { makeJournal, reach, run } from "./utils.ts"

const task = Plugin.make({
	name: "typed task",
	apply: () =>
		Plugin.fork(Effect.fail("task failed" as const)).pipe(Effect.asVoid),
})

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/background-tasks.test/Service",
) {}

describe("supervised background tasks", () => {
	it("retains asynchronous errors in definitions even when launch errors are handled", () => {
		const typed: Plugin.Plugin<void, void, "task failed"> = task
		assert.isTrue(Plugin.isPlugin(typed))
		// @ts-expect-error A task's error cannot disappear from its plugin contract.
		const quiet: Plugin.Plugin<void, void, never> = task
		assert.isTrue(Plugin.isPlugin(quiet))
		const caught = Plugin.make({
			name: "caught launch",
			apply: () =>
				Plugin.fork(Effect.fail("task failed" as const)).pipe(
					Effect.catchCause(() => Effect.void),
					Effect.asVoid,
				),
		})
		const stillTyped: Plugin.Plugin<void, void, "task failed"> = caught
		assert.isTrue(Plugin.isPlugin(stillTyped))
		// @ts-expect-error Handling the launch effect does not handle the worker.
		const stillNotQuiet: Plugin.Plugin<void, void, never> = caught
		assert.isTrue(Plugin.isPlugin(stillNotQuiet))
		const updated = Plugin.make({
			name: "update task",
			config: Schema.String,
			apply: () =>
				Effect.succeed(() =>
					Plugin.fork(Effect.fail("update failed" as const)).pipe(
						Effect.as(true),
					),
				),
		})
		const updateTyped: Plugin.Plugin<string, string, "update failed"> = updated
		assert.isTrue(Plugin.isPlugin(updateTyped))
		const service = Plugin.service(
			Service,
			Plugin.fork(Effect.fail("service failed" as const)).pipe(
				Effect.as("ready"),
			),
			{ name: "service task" },
		)
		const serviceTyped: Plugin.Plugin<
			void,
			void,
			"service failed" | Graft.ServiceConflict
		> = service
		assert.isTrue(Plugin.isPlugin(serviceTyped))
		const layer = Plugin.layer(
			Layer.effect(
				Service,
				Plugin.fork(Effect.fail("layer failed" as const)).pipe(
					Effect.as("ready"),
				),
			),
			{ name: "layer task", provides: [Service] },
		)
		const layerTyped: Plugin.Plugin<
			void,
			void,
			"layer failed" | Graft.ServiceConflict
		> = layer
		assert.isTrue(Plugin.isPlugin(layerTyped))
		const nested = Plugin.make({
			name: "nested task",
			apply: () =>
				Plugin.fork(Plugin.fork(Effect.fail("nested failed" as const))).pipe(
					Effect.asVoid,
				),
		})
		const nestedTyped: Plugin.Plugin<void, void, "nested failed"> = nested
		assert.isTrue(Plugin.isPlugin(nestedTyped))
		const missing = {
			name: "missing worker service",
			apply: () => Plugin.fork(Service).pipe(Effect.asVoid),
		}
		// @ts-expect-error A background task still requires declared dependencies.
		assert.isTrue(Plugin.isPlugin(Plugin.make(missing)))
		const quietDefinition = Plugin.make({
			name: "quiet",
			apply: () => Effect.void,
		})
		// @ts-expect-error Replacing a quiet plugin cannot introduce asynchronous errors.
		const incompatible = Graft.replace([[quietDefinition, task]])
		assert.isTrue(Effect.isEffect(incompatible))
	})

	it.effect(
		"fails an active plugin and releases its resources after a worker fails",
		() =>
			Effect.gen(function* () {
				const fail = yield* Deferred.make<void>()
				const journal = yield* makeJournal
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "worker owner",
						apply: () =>
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() => journal.record("released"))
								yield* Plugin.fork(
									Deferred.await(fail).pipe(
										Effect.andThen(Effect.fail("worker failed")),
									),
								)
							}),
					}),
				)
				yield* fork.await
				yield* Deferred.succeed(fail, undefined)
				yield* reach(fork, "Failed")
				const exit = yield* Effect.exit(fork.await)
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "loading owner",
						apply: () =>
							Plugin.fork(Effect.fail("early failure")).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(Ref.set(stopped, true)),
							),
					}),
				)
				yield* reach(fork, "Failed")
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "two workers",
						apply: () =>
							Effect.gen(function* () {
								yield* Plugin.fork(
									Deferred.succeed(started, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.ensuring(Effect.die("worker cleanup defect")),
									),
								)
								yield* Plugin.fork(
									Deferred.await(fail).pipe(
										Effect.andThen(Effect.fail("initial failure")),
									),
								)
							}),
					}),
				)
				yield* fork.await
				yield* Deferred.await(started)
				yield* Deferred.succeed(fail, undefined)
				yield* reach(fork, "Failed")
				const exit = yield* Effect.exit(fork.await)
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
		"uses the accepted configuration when a worker fails after an in-place update",
		() =>
			Effect.gen(function* () {
				const fail = yield* Deferred.make<void>()
				const starts = yield* Ref.make(0)
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "updated owner",
						config: Schema.String,
						apply: () =>
							Effect.gen(function* () {
								yield* Ref.update(starts, (n) => n + 1)
								yield* Plugin.fork(
									Deferred.await(fail).pipe(
										Effect.andThen(Effect.fail("late failure")),
									),
								)
								return () => Effect.succeed(true)
							}),
					}),
					"initial",
				)
				yield* fork.await
				yield* fork.update("accepted")
				yield* Deferred.succeed(fail, undefined)
				yield* reach(fork, "Failed")
				yield* TestClock.adjust("1 millis")
				const count = yield* Ref.get(starts)
				const snapshot = yield* Stream.runHead(Graft.forks)
				assert.strictEqual(count, 1)
				assert.strictEqual(Option.getOrThrow(snapshot)[0]?.input, "accepted")
			}).pipe(run),
	)

	it.effect(
		"bounds retries of background failures with the plugin schedule",
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "retrying workers",
						retry,
						apply: () =>
							Effect.gen(function* () {
								yield* Ref.update(attempts, (n) => n + 1)
								yield* Plugin.fork(Effect.fail("task failed"))
							}),
					}),
				)
				yield* Deferred.await(exhausted)
				const count = yield* Ref.get(attempts)
				const snapshot = yield* Stream.runHead(fork.state)
				assert.strictEqual(count, 2)
				assert.strictEqual(Option.getOrThrow(snapshot)._tag, "Failed")
			}).pipe(run),
	)

	it.effect(
		"ignores pure worker interruption while keeping the activation alive",
		() =>
			Effect.gen(function* () {
				const worker = yield* Deferred.make<Fiber.Fiber<never>>()
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "cancelled worker",
						apply: () =>
							Effect.gen(function* () {
								const fiber = yield* Plugin.fork(Effect.interrupt)
								yield* Deferred.succeed(worker, fiber)
							}),
					}),
				)
				const fiber = yield* Deferred.await(worker)
				yield* Fiber.await(fiber)
				yield* fork.await
				const snapshot = yield* Stream.runHead(fork.state)
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "resource owner",
						apply: () =>
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() => Ref.set(live, false))
								yield* Plugin.fork(
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
					}),
				)
				yield* fork.await
				yield* Deferred.await(started)
				const closing = yield* Effect.forkScoped(fork.dispose)
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
	it.effect("preempts an update that starts a failing worker", () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "update launcher",
					config: Schema.String,
					apply: () =>
						Effect.succeed(() =>
							Plugin.fork(Effect.fail("update task failed")).pipe(
								Effect.andThen(Effect.never),
							),
						),
				}),
				"initial",
			)
			yield* fork.await
			yield* fork.update("processing")
			yield* reach(fork, "Failed")
			const exit = yield* Effect.exit(fork.await)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.deepStrictEqual(
					Cause.findErrorOption(exit.cause),
					Option.some("update task failed"),
				)
			const snapshot = yield* Stream.runHead(Graft.forks)
			assert.strictEqual(Option.getOrThrow(snapshot)[0]?.input, "processing")
		}).pipe(run),
	)

	it.effect(
		"preserves worker cleanup defects when disposal wins the race",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "disposed worker",
						apply: () =>
							Plugin.fork(
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(Effect.die("disposed worker defect")),
								),
							).pipe(Effect.asVoid),
					}),
				)
				yield* fork.await
				yield* Deferred.await(started)
				const cleanup = yield* Effect.exit(fork.dispose)
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "finalizer context",
						apply: () =>
							Effect.gen(function* () {
								yield* Effect.addFinalizer((exit) =>
									Deferred.succeed(observed, exit),
								)
								yield* Plugin.fork(Effect.fail("resource owner failed"))
							}),
					}),
				)
				yield* reach(fork, "Failed")
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "scoped launcher",
						apply: () =>
							Effect.gen(function* () {
								const fiber = yield* Plugin.fork(
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
					}),
				)
				yield* fork.await
				yield* Deferred.await(acquired)
				const early = yield* Ref.get(released)
				assert.isFalse(early)
				yield* Deferred.succeed(finish, undefined)
				const fiber = yield* Deferred.await(worker)
				yield* Fiber.join(fiber)
				const after = yield* Ref.get(released)
				assert.isTrue(after)
				const snapshot = yield* Stream.runHead(fork.state)
				assert.strictEqual(Option.getOrThrow(snapshot)._tag, "Active")
			}).pipe(run),
	)

	it.effect("supervises defects from a task's scoped finalizers", () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "task finalizer",
					apply: () =>
						Plugin.fork(
							Effect.acquireRelease(Effect.void, () =>
								Effect.die("scoped worker cleanup failed"),
							),
						).pipe(Effect.asVoid),
				}),
			)
			yield* reach(fork, "Failed")
			const exit = yield* Effect.exit(fork.await)
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
