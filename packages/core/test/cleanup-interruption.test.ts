import {
	Cause,
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
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Mount, Release } from "../src/index.ts"

const assertReleaseInterruption = <E>(cause: Cause.Cause<E>) => {
	assert.isAbove(cause.reasons.length, 0)
	for (const reason of cause.reasons) {
		assert(reason._tag === "Die")
		assert(Schema.is(Release.ReleaseInterrupted)(reason.defect))
		assert.isTrue(Cause.hasInterruptsOnly(reason.defect.cause))
	}
}

for (const mode of ["self", "worker"]) {
	it.effect(
		`reports a finalizer's ${mode} interruption on repeated disposal`,
		() =>
			Effect.gen(function* () {
				const completed = yield* Ref.make(false)
				const independent = yield* Ref.make(false)
				yield* Effect.gen(function* () {
					const mount = yield* Graft.mount(
						Layer.effectDiscard(
							Effect.gen(function* () {
								const worker = yield* Graft.fork(Effect.never)
								yield* Effect.addFinalizer(() => Ref.set(independent, true))
								yield* Effect.addFinalizer(() =>
									(mode === "self"
										? Effect.interrupt
										: Fiber.join(worker)
									).pipe(Effect.andThen(Ref.set(completed, true))),
								)
							}),
						),
						{ name: "interrupted cleanup" },
					)
					yield* mount.await
					for (const attempt of [1, 2]) {
						const result = yield* Effect.result(mount.unmount)
						assert(
							result._tag === "Failure",
							`unmount ${attempt} must report unfinished cleanup`,
						)
						assert.strictEqual(result.failure._tag, "CleanupError")
						assertReleaseInterruption(result.failure.cause)
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
			const mount = yield* Graft.mount(
				Layer.effectDiscard(Effect.addFinalizer(() => Effect.interrupt)),
				{ name: "automatic cleanup interruption" },
			)
			yield* mount.await
		}).pipe(Effect.scoped, Effect.provide(Graft.layer), Effect.exit)
		assert(Exit.isFailure(result))
		const error = Cause.squash(result.cause)
		assert(Schema.is(Mount.CleanupError)(error))
		assertReleaseInterruption(error.cause)
	}),
)

for (const finish of ["success", "cancel"]) {
	it.effect(`retains worker scope interruption after body ${finish}`, () =>
		Effect.gen(function* () {
			const ready = yield* Deferred.make<void>()
			const completed = yield* Ref.make(false)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Graft.fork(
						Effect.addFinalizer(() =>
							Effect.interrupt.pipe(Effect.andThen(Ref.set(completed, true))),
						).pipe(
							Effect.andThen(Deferred.succeed(ready, undefined)),
							Effect.andThen(finish === "cancel" ? Effect.never : Effect.void),
						),
					).pipe(Effect.asVoid),
				),
				{ name: "worker resource interruption" },
			)
			yield* Deferred.await(ready)
			if (finish === "success") {
				const state = yield* mount.state.pipe(
					Stream.filter((state) => state._tag === "Failed"),
					Stream.runHead,
				)
				assert(Option.isSome(state) && state.value._tag === "Failed")
				assertReleaseInterruption(state.value.cause)
			} else yield* mount.await
			if (finish === "cancel") {
				for (const attempt of [1, 2]) {
					const result = yield* Effect.result(mount.unmount)
					assert(
						result._tag === "Failure",
						`unmount ${attempt} must retain worker cleanup`,
					)
					assertReleaseInterruption(result.failure.cause)
				}
			} else {
				// Once supervision publishes Failed, it owns the completed attempt's cause.
				yield* mount.unmount
				yield* mount.unmount
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
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Graft.fork(
						Effect.addFinalizer(() => Effect.interrupt).pipe(
							Effect.andThen(Deferred.succeed(ready, undefined)),
							Effect.andThen(Effect.never),
						),
					).pipe(Effect.asVoid),
				),
				{ name: "owned worker resource" },
			)
			yield* mount.await
			yield* Deferred.await(ready)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer), Effect.exit)
		assert(Exit.isFailure(result))
		const error = Cause.squash(result.cause)
		assert(Schema.is(Mount.CleanupError)(error))
		assertReleaseInterruption(error.cause)
	}),
)

for (const phase of ["apply", "retry initialization", "retry step"]) {
	it.effect(`retains pure cleanup interruption while cancelling ${phase}`, () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const pending = Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Effect.never),
				Effect.ensuring(Effect.interrupt),
			)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					phase === "apply" ? pending : Effect.fail("startup failed"),
				),
				{
					name: "interrupted operation cleanup",
					...(phase === "retry initialization"
						? { retry: Schedule.fromStep(pending) }
						: phase === "retry step"
							? { retry: Schedule.fromStep(Effect.succeed(() => pending)) }
							: {}),
				},
			)
			yield* Deferred.await(entered)
			const result = yield* Effect.result(mount.unmount)
			assert(result._tag === "Failure")
			assert.strictEqual(result.failure._tag, "CleanupError")
			assert.isTrue(Cause.hasInterruptsOnly(result.failure.cause))
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
	)
}
