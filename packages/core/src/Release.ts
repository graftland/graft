/** Scoped resource release that distinguishes pure release interruption from cancellation. */
import { Array, Cause, Effect, Exit, Result, Schema, Scope } from "effect"

/** Resource release was interrupted, rather than successfully cancelled. */
export class ReleaseInterrupted extends Schema.TaggedError<
	ReleaseInterrupted,
	{ readonly brand: unique symbol }
>()("ReleaseInterrupted", {
	cause: Schema.Cause(Schema.Never, Schema.Unknown),
}) {
	override get message() {
		return "Resource release was interrupted"
	}
}

/** Separates pending external cancellation from interrupted finalizers in an interrupt-only release cause. */
// Built once at module load: close runs on every scoped handler invocation.
const markReleaseInterrupts = Effect.fnUntraced(function* (
	cause: Cause.Cause<never>,
): Effect.fn.Return<never> {
	// Re-entering interruptibility observes pending external cancellation without producing a self-interrupt.
	// Read it after release so cancellation arriving during a finalizer is included too.
	const pending = yield* Effect.exit(Effect.interruptible(Effect.void))
	const [cancelled, interrupted] = Array.partition(cause.reasons, (reason) =>
		Exit.isFailure(pending) &&
		Array.some(
			pending.cause.reasons,
			(external) =>
				reason._tag === "Interrupt" &&
				external._tag === "Interrupt" &&
				reason.fiberId === external.fiberId,
		)
			? Result.succeed(reason)
			: Result.fail(reason),
	)
	if (interrupted.length === 0) return yield* Effect.failCause(cause)
	return yield* Effect.failCause(
		Cause.combine(
			Cause.fromReasons(cancelled),
			Cause.die(
				ReleaseInterrupted.make({
					cause: Cause.fromReasons(interrupted),
				}),
			),
		),
	)
})

/**
 * Closes a scope without losing interrupted finalizers through enclosing cancellation.
 * When the release cause contains only interrupts, pending external cancellation
 * remains an Interrupt; release itself becomes a ReleaseInterrupted defect carrying
 * the original cause. Causes containing other failures remain unchanged.
 */
export const close = (
	scope: Scope.Closeable,
	exit: Exit.Exit<unknown, unknown>,
) =>
	Effect.uninterruptible(
		Scope.close(scope, exit).pipe(
			Effect.catchCauseIf(Cause.hasInterruptsOnly, markReleaseInterrupts),
		),
	)

/**
 * Runs an effect in its own scope and closes it with close.
 * Body and release failures are combined; a failed release never hides the body cause.
 */
// Event dispatch runs this once per handler invocation, so it chains combinators instead of a generator.
export const scoped = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.flatMap(Scope.make(), (scope) =>
			Effect.flatMap(
				Effect.exit(restore(Scope.provide(scope)(effect))),
				(body) =>
					Effect.flatMap(Effect.exit(close(scope, body)), (closed) =>
						Exit.isFailure(closed)
							? Effect.failCause(
									Exit.isFailure(body)
										? Cause.combine(body.cause, closed.cause)
										: closed.cause,
								)
							: body,
					),
			),
		),
	)
