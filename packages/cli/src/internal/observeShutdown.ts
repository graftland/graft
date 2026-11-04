import { Array, Cause, Effect, Exit, Fiber } from "effect"

/** Observe self-interrupted cleanup before a stream or scoped fork discards its Exit. */
export const observeShutdown = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	message: string,
) =>
	Effect.scoped(
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const owner = yield* Effect.withFiber((self) => Effect.succeed(self.id))
				const worker = yield* Effect.forkScoped(restore(effect))
				const waiting = yield* Effect.exit(restore(Fiber.await(worker)))
				if (Exit.isFailure(waiting)) yield* Fiber.interrupt(worker)
				const exit = yield* Fiber.await(worker)
				// Ordinary failures already have their own logger; only unexpected pure interruption needs this outlet.
				if (
					Exit.isFailure(exit) &&
					Cause.hasInterruptsOnly(exit.cause) &&
					!(
						Exit.isFailure(waiting) &&
						Array.every(
							exit.cause.reasons,
							(reason) =>
								reason._tag === "Interrupt" && reason.fiberId === owner,
						)
					)
				)
					yield* Effect.logError(message, exit.cause)
				return yield* exit
			}),
		),
	)
