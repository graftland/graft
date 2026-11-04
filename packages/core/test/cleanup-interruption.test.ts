import { assert, it } from "@effect/vitest"
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { Graft, Plugin, Fork } from "../src/index.ts"

for (const mode of ["self", "worker"]) {
	it.effect(
		`reports a finalizer's ${mode} interruption on repeated disposal`,
		() =>
			Effect.gen(function* () {
				const completed = yield* Ref.make(false)
				const independent = yield* Ref.make(false)
				yield* Effect.gen(function* () {
					const fork = yield* Graft.plugin(
						Plugin.make({
							name: "interrupted cleanup",
							apply: () =>
								Effect.gen(function* () {
									const worker = yield* Plugin.fork(Effect.never)
									yield* Effect.addFinalizer(() => Ref.set(independent, true))
									yield* Effect.addFinalizer(() =>
										(mode === "self"
											? Effect.interrupt
											: Fiber.join(worker)
										).pipe(Effect.andThen(Ref.set(completed, true))),
									)
								}),
						}),
					)
					yield* fork.await
					for (const attempt of [1, 2]) {
						const result = yield* Effect.result(fork.dispose)
						assert(
							result._tag === "Failure",
							`dispose ${attempt} must report unfinished cleanup`,
						)
						assert.strictEqual(result.failure._tag, "CleanupError")
						assert.isTrue(Cause.hasInterruptsOnly(result.failure.cause))
					}
				}).pipe(Effect.scoped, Effect.provide(Graft.layer))
				const finished = yield* Ref.get(completed)
				assert.isFalse(finished)
				const otherReleased = yield* Ref.get(independent)
				assert.isTrue(otherReleased)
			}),
	)
}

it.effect("reports an interrupted finalizer when its owner scope closes", () =>
	Effect.gen(function* () {
		const result = yield* Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "automatic cleanup interruption",
					apply: () => Effect.addFinalizer(() => Effect.interrupt),
				}),
			)
			yield* fork.await
		}).pipe(Effect.scoped, Effect.provide(Graft.layer), Effect.exit)
		assert(Exit.isFailure(result))
		const error = Cause.squash(result.cause)
		assert(Schema.is(Fork.CleanupError)(error))
		assert.isTrue(Cause.hasInterruptsOnly(error.cause))
	}),
)

for (const finish of ["success", "cancel"]) {
	it.effect(`retains worker scope interruption after body ${finish}`, () =>
		Effect.gen(function* () {
			const ready = yield* Deferred.make<void>()
			const completed = yield* Ref.make(false)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "worker resource interruption",
					apply: () =>
						Plugin.fork(
							Effect.addFinalizer(() =>
								Effect.interrupt.pipe(Effect.andThen(Ref.set(completed, true))),
							).pipe(
								Effect.andThen(Deferred.succeed(ready, undefined)),
								Effect.andThen(
									finish === "cancel" ? Effect.never : Effect.void,
								),
							),
						).pipe(Effect.asVoid),
				}),
			)
			yield* Deferred.await(ready)
			if (finish === "success") {
				const state = yield* fork.state.pipe(
					Stream.filter((state) => state._tag === "Failed"),
					Stream.runHead,
				)
				assert(Option.isSome(state) && state.value._tag === "Failed")
				assert.isTrue(Cause.hasInterruptsOnly(state.value.cause))
			} else yield* fork.await
			if (finish === "cancel") {
				for (const attempt of [1, 2]) {
					const result = yield* Effect.result(fork.dispose)
					assert(
						result._tag === "Failure",
						`dispose ${attempt} must retain worker cleanup`,
					)
					assert.isTrue(Cause.hasInterruptsOnly(result.failure.cause))
				}
			} else {
				// Once supervision publishes Failed, it owns the completed attempt's cause.
				yield* fork.dispose
				yield* fork.dispose
			}
			const released = yield* Ref.get(completed)
			assert.isFalse(released)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
	)
}

it.effect("reports worker scope interruption on automatic disposal", () =>
	Effect.gen(function* () {
		const ready = yield* Deferred.make<void>()
		const result = yield* Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "owned worker resource",
					apply: () =>
						Plugin.fork(
							Effect.addFinalizer(() => Effect.interrupt).pipe(
								Effect.andThen(Deferred.succeed(ready, undefined)),
								Effect.andThen(Effect.never),
							),
						).pipe(Effect.asVoid),
				}),
			)
			yield* fork.await
			yield* Deferred.await(ready)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer), Effect.exit)
		assert(Exit.isFailure(result))
		const error = Cause.squash(result.cause)
		assert(Schema.is(Fork.CleanupError)(error))
		assert.isTrue(Cause.hasInterruptsOnly(error.cause))
	}),
)

for (const phase of ["apply", "update", "retry initialization", "retry step"]) {
	it.effect(`retains pure cleanup interruption while cancelling ${phase}`, () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const pending = Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Effect.interrupt),
			)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "interrupted operation cleanup",
					...(phase === "retry initialization"
						? { retry: Schedule.fromStep(pending) }
						: phase === "retry step"
							? { retry: Schedule.fromStep(Effect.succeed(() => pending)) }
							: {}),
					apply: () =>
						phase === "apply"
							? pending
							: phase === "update"
								? Effect.succeed(() => pending)
								: Effect.fail("startup failed"),
				}),
			)
			if (phase === "update") {
				yield* fork.await
				yield* fork.update(undefined).pipe(Effect.forkScoped)
			}
			yield* Deferred.await(entered)
			const result = yield* Effect.result(fork.dispose)
			assert(result._tag === "Failure")
			assert.strictEqual(result.failure._tag, "CleanupError")
			assert.isTrue(Cause.hasInterruptsOnly(result.failure.cause))
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
	)
}
