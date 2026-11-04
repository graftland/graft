import { assert, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	Schema,
} from "effect"
import * as Release from "../src/internal/release"

for (const mode of ["masked", "interruptible", "self", "joined", "mixed"]) {
	for (const timing of ["body", "release"]) {
		it.effect(
			`distinguishes ${mode} release interruption when cancellation reaches ${timing}`,
			() =>
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>()
					const closing = yield* Deferred.make<void>()
					const finish = yield* Deferred.make<void>()
					const completed = yield* Ref.make(false)
					const canceller = yield* Effect.withFiber((self) =>
						Effect.succeed(self.id),
					)
					const unrelated = yield* Effect.forkScoped(Effect.interrupt)
					yield* Fiber.await(unrelated)
					const work = Effect.gen(function* () {
						if (mode === "mixed")
							yield* Effect.addFinalizer(() =>
								Effect.interruptible(Effect.void),
							)
						yield* Effect.addFinalizer(() =>
							Deferred.succeed(closing, undefined).pipe(
								Effect.andThen(Deferred.await(finish)),
								Effect.andThen(
									mode === "interruptible"
										? Effect.interruptible(Effect.void)
										: mode === "self" || mode === "mixed"
											? Effect.interrupt
											: mode === "joined"
												? Fiber.join(unrelated)
												: Effect.void,
								),
								Effect.andThen(Ref.set(completed, true)),
							),
						)
						yield* Deferred.succeed(entered, undefined)
						if (timing === "body") return yield* Effect.never
					})
					const worker = yield* Release.scoped(work).pipe(Effect.forkScoped)
					yield* timing === "body"
						? Deferred.await(entered)
						: Deferred.await(closing)
					const stopping = yield* Fiber.interruptAs(worker, canceller).pipe(
						Effect.forkScoped({ startImmediately: true }),
					)
					yield* Deferred.await(closing)
					yield* Deferred.succeed(finish, undefined)
					yield* Fiber.join(stopping)
					const exit = yield* Fiber.await(worker)
					assert(Exit.isFailure(exit))
					assert.isTrue(
						Array.some(
							exit.cause.reasons,
							(reason) =>
								reason._tag === "Interrupt" && reason.fiberId === canceller,
						),
					)
					if (mode === "masked" || mode === "interruptible") {
						assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
					} else {
						const release = Cause.squash(exit.cause)
						assert(Schema.is(Release.ReleaseInterrupted)(release))
						assert.isTrue(Cause.hasInterruptsOnly(release.cause))
						assert.isTrue(
							Array.every(
								release.cause.reasons,
								(reason) =>
									reason._tag === "Interrupt" &&
									reason.fiberId ===
										(mode === "joined" ? unrelated.id : worker.id),
							),
						)
					}
					const released = yield* Ref.get(completed)
					assert.strictEqual(released, mode === "masked")
				}).pipe(Effect.scoped),
		)
	}
}
