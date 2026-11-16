import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
	String,
} from "effect"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { CleanupError } from "../src/Mount.ts"
import { reach, run } from "./b1c-utils.ts"

for (const phase of ["initialize", "step"] as const) {
	it.effect("restarts cancel retry " + phase, () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const cancelled = yield* Deferred.make<void>()
			const pending = Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Deferred.succeed(cancelled, undefined)),
			)
			const mode = yield* Ref.make(true)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						if (yield* Ref.get(mode))
							return yield* Effect.fail("startup failure")
					}),
				),
				{
					name: "retry initialization probe",
					retry:
						phase === "initialize"
							? Schedule.fromStep(pending)
							: Schedule.fromStep(Effect.succeed(() => pending)),
				},
			)
			yield* Deferred.await(entered)
			yield* Ref.set(mode, false)
			yield* mount.restart
			const stopped = yield* Deferred.isDone(cancelled)
			assert.isTrue(
				stopped,
				"The obsolete retry must finish cleanup before the restart is accepted",
			)
			yield* reach(mount, "Active")
			yield* mount.unmount
		}).pipe(run),
	)
}

for (const phase of ["initialize", "step"] as const) {
	it.effect(`retains ${phase} cancellation cleanup in repeated unmount`, () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const pending = Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Effect.die("retry cleanup defect")),
			)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(Effect.fail("published startup failure")),
				{
					name: "retry disposal",
					retry:
						phase === "initialize"
							? Schedule.fromStep(pending)
							: Schedule.fromStep(Effect.succeed(() => pending)),
				},
			)
			yield* Deferred.await(entered)
			const result = yield* Effect.exit(mount.unmount)
			const repeated = yield* Effect.exit(mount.unmount)
			assert.deepStrictEqual(result, repeated)
			assert.isTrue(Exit.isFailure(result))
			if (Exit.isFailure(result)) {
				const error = Cause.findErrorOption(result.cause)
				assert.isTrue(Option.isSome(error))
				if (Option.isSome(error)) {
					assert.isTrue(Schema.is(CleanupError)(error.value))
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
		`publishes ${phase} failure before waiting for another restart`,
		() =>
			Effect.gen(function* () {
				const failed = Effect.die("retry operation defect")
				const mode = yield* Ref.make(true)
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							if (yield* Ref.get(mode))
								return yield* Effect.fail("startup failure")
						}),
					),
					{
						name: "retry failure",
						retry:
							phase === "initialize"
								? Schedule.fromStep(failed)
								: Schedule.fromStep(Effect.succeed(() => failed)),
					},
				)
				const state = yield* mount.state.pipe(
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
				const result = yield* Effect.exit(mount.await)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) {
					assert.include(Cause.pretty(result.cause), "startup failure")
					assert.include(Cause.pretty(result.cause), "retry operation defect")
				}
				yield* Ref.set(mode, false)
				yield* mount.restart
				yield* reach(mount, "Active")
				yield* mount.unmount
			}).pipe(run),
	)
}

it.effect("dependency changes cancel retry initialization", () =>
	Effect.gen(function* () {
		class Ready extends Context.Service<Ready, boolean>()(
			"@graftland/graft/test/retry-lifecycle.test/Ready",
		) {}
		const entered = yield* Deferred.make<void>()
		const consumer = yield* Graft.mount(
			Layer.effectDiscard(
				Effect.gen(function* () {
					const value = yield* Effect.serviceOption(Ready)
					if (Option.isNone(value)) return yield* Effect.fail("not ready")
				}),
			),
			{
				name: "retry on dependency change",
				requires: [Graft.optional(Ready)],
				retry: Schedule.fromStep(
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				),
			},
		)
		yield* Deferred.await(entered)
		const provider = yield* Graft.publish(Ready, true)
		yield* provider.await
		yield* reach(consumer, "Active")
		yield* consumer.unmount
	}).pipe(run),
)

it.effect("unmount observes retry cleanup already started by a restart", () =>
	Effect.gen(function* () {
		const entered = yield* Deferred.make<void>()
		const cleaning = yield* Deferred.make<void>()
		const release = yield* Deferred.make<void>()
		const stopping = yield* Deferred.make<void>()
		const mode = yield* Ref.make(true)
		const mount = yield* Graft.mount(
			Layer.effectDiscard(
				Effect.gen(function* () {
					if (yield* Ref.get(mode)) return yield* Effect.fail("startup failure")
				}),
			),
			{
				name: "retry cleanup handoff",
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
		yield* Ref.set(mode, false)
		const changing = yield* Effect.forkScoped(mount.restart)
		yield* Deferred.await(cleaning)
		const closing = yield* Effect.forkScoped(Effect.exit(mount.unmount))
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
	"publishes retry cancellation failures on restarts without replaying them at unmount",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const mode = yield* Ref.make(true)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						if (yield* Ref.get(mode))
							return yield* Effect.fail("startup failure")
					}),
				),
				{
					name: "retry failure handoff",
					retry: Schedule.fromStep(
						Effect.succeed(() =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(Effect.die("obsolete retry cleanup")),
							),
						),
					),
				},
			)
			yield* Deferred.await(entered)
			const failed = yield* mount.state.pipe(
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
			yield* Ref.set(mode, false)
			yield* mount.restart
			const observed = yield* Fiber.join(failed)
			const state = Option.getOrThrow(observed)
			assert.strictEqual(state._tag, "Failed")
			if (state._tag === "Failed") {
				assert.include(Cause.pretty(state.cause), "startup failure")
				assert.include(Cause.pretty(state.cause), "obsolete retry cleanup")
			}
			yield* reach(mount, "Active")
			yield* mount.unmount
		}).pipe(run),
)
