import { Effect, Exit, Fiber, Scope } from "effect"

import * as Release from "../Release"

export interface Execution<A, E> {
	readonly fiber: Fiber.Fiber<A, E>
	readonly stop: Effect.Effect<Exit.Exit<A, E>>
	readonly close: Effect.Effect<void>
}

/** A deadline bounds observers; only the original executor Exit permits resource cleanup. */
export const start = Effect.fnUntraced(function* <A, E>(
	owner: Scope.Scope,
	resources: Scope.Closeable,
	execute: Effect.Effect<A, E, Scope.Scope>,
	observe: (exit: Exit.Exit<A, E>) => Effect.Effect<void>,
): Effect.fn.Return<Execution<A, E>> {
	return yield* Effect.uninterruptible(
		Effect.gen(function* () {
			const fiber = yield* Scope.provide(
				Effect.interruptible(execute),
				resources,
			).pipe(Effect.onExit(observe), Effect.forkIn(owner))
			const stop = Effect.uninterruptible(
				Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
			)
			return {
				fiber,
				stop,
				close: stop.pipe(Effect.andThen(Release.close(resources, Exit.void))),
			}
		}),
	)
})
