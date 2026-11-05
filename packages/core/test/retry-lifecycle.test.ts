import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Schedule,
	Schema,
	Stream,
	String,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Fork, Graft, Plugin } from "../src/index.ts"
import { reach, run } from "./utils.ts"

for (const phase of ["initialize", "step"] as const) {
	it.effect("configuration changes cancel retry " + phase, () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const cancelled = yield* Deferred.make<void>()
			const pending = Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Deferred.succeed(cancelled, undefined)),
			)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "retry initialization probe",
					config: Schema.Boolean,
					retry:
						phase === "initialize"
							? Schedule.fromStep(pending)
							: Schedule.fromStep(Effect.succeed(() => pending)),
					apply: (broken) =>
						broken ? Effect.fail("startup failure") : Effect.void,
				}),
				true,
			)
			yield* Deferred.await(entered)
			yield* fork.update(false)
			const stopped = yield* Deferred.isDone(cancelled)
			assert.isTrue(
				stopped,
				"The obsolete retry must finish cleanup before the update is accepted",
			)
			yield* reach(fork, "Active")
			yield* fork.dispose
		}).pipe(run),
	)
}

for (const phase of ["initialize", "step"] as const) {
	it.effect(`retains ${phase} cancellation cleanup in repeated disposal`, () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const pending = Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Effect.die("retry cleanup defect")),
			)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "retry disposal",
					retry:
						phase === "initialize"
							? Schedule.fromStep(pending)
							: Schedule.fromStep(Effect.succeed(() => pending)),
					apply: () => Effect.fail("published startup failure"),
				}),
			)
			yield* Deferred.await(entered)
			const result = yield* Effect.exit(fork.dispose)
			const repeated = yield* Effect.exit(fork.dispose)
			assert.deepStrictEqual(result, repeated)
			assert.isTrue(Exit.isFailure(result))
			if (Exit.isFailure(result)) {
				const error = Cause.findErrorOption(result.cause)
				assert.isTrue(Option.isSome(error))
				if (Option.isSome(error)) {
					assert.isTrue(Schema.is(Fork.CleanupError)(error.value))
					assert.include(
						Cause.pretty(error.value.cause),
						"retry cleanup defect",
					)
					assert.notInclude(
						Cause.pretty(error.value.cause),
						"published startup failure",
					)
					assert.isTrue(Cause.hasInterrupts(error.value.cause))
				}
			}
		}).pipe(run),
	)

	it.effect(
		`publishes ${phase} failure before waiting for another configuration`,
		() =>
			Effect.gen(function* () {
				const failed = Effect.die("retry operation defect")
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "retry failure",
						config: Schema.Boolean,
						retry:
							phase === "initialize"
								? Schedule.fromStep(failed)
								: Schedule.fromStep(Effect.succeed(() => failed)),
						apply: (broken) =>
							broken ? Effect.fail("startup failure") : Effect.void,
					}),
					true,
				)
				const state = yield* fork.state.pipe(
					Stream.filter(
						(state) =>
							state._tag === "Failed" &&
							String.includes("retry operation defect")(
								Cause.pretty(state.cause),
							),
					),
					Stream.runHead,
				)
				assert.isTrue(Option.isSome(state))
				const result = yield* Effect.exit(fork.await)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) {
					assert.include(Cause.pretty(result.cause), "startup failure")
					assert.include(Cause.pretty(result.cause), "retry operation defect")
				}
				yield* fork.update(false)
				yield* reach(fork, "Active")
				yield* fork.dispose
			}).pipe(run),
	)
}

it.effect("dependency changes cancel retry initialization", () =>
	Effect.gen(function* () {
		class Ready extends Context.Service<Ready, boolean>()(
			"@graftland/graft/test/retry-lifecycle.test/Ready",
		) {}
		const entered = yield* Deferred.make<void>()
		const consumer = yield* Graft.plugin(
			Plugin.make({
				name: "retry on dependency change",
				inject: [Plugin.optional(Ready)],
				retry: Schedule.fromStep(
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				),
				apply: () =>
					Effect.serviceOption(Ready).pipe(
						Effect.flatMap((value) =>
							Option.isSome(value) ? Effect.void : Effect.fail("not ready"),
						),
					),
			}),
		)
		yield* Deferred.await(entered)
		const provider = yield* Graft.plugin(
			Plugin.service(Ready, Effect.succeed(true), { name: "ready" }),
		)
		yield* provider.await
		yield* reach(consumer, "Active")
		yield* consumer.dispose
	}).pipe(run),
)

it.effect(
	"disposal observes retry cleanup already started by a configuration change",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const cleaning = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const stopping = yield* Deferred.make<void>()
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "retry cleanup handoff",
					config: Schema.Boolean,
					retry: Schedule.fromStep(
						Effect.succeed(() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(
									Deferred.succeed(cleaning, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
										Effect.andThen(Effect.die("overlapping retry cleanup")),
									),
								),
							),
						),
					),
					apply: (broken) =>
						broken ? Effect.fail("startup failure") : Effect.void,
				}),
				true,
				{
					intercept: [
						{
							apply: (effect) =>
								Effect.raceFirst(
									effect,
									Effect.never.pipe(
										Effect.onInterrupt(() =>
											Deferred.succeed(stopping, undefined),
										),
									),
								),
						},
					],
				},
			)
			yield* Deferred.await(entered)
			const changing = yield* Effect.forkScoped(fork.update(false))
			yield* Deferred.await(cleaning)
			const closing = yield* Effect.forkScoped(Effect.exit(fork.dispose))
			yield* Deferred.await(stopping)
			yield* Deferred.succeed(release, undefined)
			const result = yield* Fiber.join(closing)
			yield* Fiber.join(changing)
			assert.isTrue(Exit.isFailure(result))
			if (Exit.isFailure(result))
				assert.include(Cause.pretty(result.cause), "overlapping retry cleanup")
		}).pipe(run),
)

it.effect(
	"publishes retry cancellation failures on configuration changes without replaying them at disposal",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "retry failure handoff",
					config: Schema.Boolean,
					retry: Schedule.fromStep(
						Effect.succeed(() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(Effect.die("obsolete retry cleanup")),
							),
						),
					),
					apply: (broken) =>
						broken ? Effect.fail("startup failure") : Effect.void,
				}),
				true,
			)
			yield* Deferred.await(entered)
			const failed = yield* fork.state.pipe(
				Stream.filter(
					(state) =>
						state._tag === "Failed" &&
						String.includes("obsolete retry cleanup")(
							Cause.pretty(state.cause),
						),
				),
				Stream.runHead,
				Effect.forkScoped,
			)
			yield* fork.update(false)
			const observed = yield* Fiber.join(failed)
			const state = Option.getOrThrow(observed)
			assert.strictEqual(state._tag, "Failed")
			if (state._tag === "Failed") {
				assert.include(Cause.pretty(state.cause), "startup failure")
				assert.include(Cause.pretty(state.cause), "obsolete retry cleanup")
			}
			yield* reach(fork, "Active")
			yield* fork.dispose
		}).pipe(run),
)
