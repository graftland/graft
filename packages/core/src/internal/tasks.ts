import { Cause, Deferred, Effect, Exit, FiberSet, Ref, Scope } from "effect"

import * as Release from "../Release"

// This requirement carries asynchronous errors to Plugin.make; it has no public service key.
declare const TaskErrors: unique symbol
export interface Tasks<out E> {
	readonly [TaskErrors]: E
}

/** One activation owns both the workers and every failure they finish with. */
export const make = Effect.gen(function* () {
	const scope = yield* Scope.make()
	const fibers = yield* FiberSet.make<unknown, unknown>().pipe(
		Scope.provide(scope),
	)
	const failures = yield* Ref.make<Cause.Cause<unknown>>(Cause.empty)
	const cleanupFailures = yield* Ref.make<Cause.Cause<unknown>>(Cause.empty)
	return { scope, fibers, failures, cleanupFailures }
})
export type Group = Effect.Success<typeof make>

export const run = <A, E, R>(group: Group, effect: Effect.Effect<A, E, R>) =>
	FiberSet.run(
		group.fibers,
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const scope = yield* Scope.make()
				const body = yield* Effect.exit(restore(Scope.provide(scope)(effect)))
				const closed = yield* Effect.exit(Release.close(scope, body))
				if (Exit.isFailure(closed) && !Cause.hasInterruptsOnly(closed.cause))
					yield* Ref.update(group.cleanupFailures, (cause) =>
						Cause.combine(cause, closed.cause),
					)
				// Bare worker interruption is supported; nested scopes inside the body must report their own release failures, unlike the separately observed task scope.
				const failure = Cause.combine(
					Exit.isFailure(body) && !Cause.hasInterruptsOnly(body.cause)
						? body.cause
						: Cause.empty,
					// Release.close marks independent interruptions; an unmarked one is pending cancellation.
					Exit.isFailure(closed) && !Cause.hasInterruptsOnly(closed.cause)
						? closed.cause
						: Cause.empty,
				)
				if (failure.reasons.length > 0) {
					yield* Ref.update(group.failures, (cause) =>
						Cause.combine(cause, failure),
					)
					// Publish only after the task's resource scope has finished closing.
					yield* Deferred.failCause(group.fibers.deferred, failure)
					yield* Effect.logError("The plugin's background task failed", failure)
				}
				if (Exit.isFailure(closed))
					return yield* Effect.failCause(
						Exit.isFailure(body)
							? Cause.combine(body.cause, closed.cause)
							: closed.cause,
					)
				return yield* body
			}),
		),
		{ startImmediately: false },
	)
