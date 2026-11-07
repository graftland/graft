import { Array, Cause, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

import * as Release from "../Release"

export interface Execution<A, E> {
	readonly fiber: Fiber.Fiber<A, E>
	readonly stop: Effect.Effect<Exit.Exit<A, E>>
	readonly run: <B, F>(
		effect: Effect.Effect<B, F, Scope.Scope>,
	) => Effect.Effect<Fiber.Fiber<B, F>>
	readonly close: Effect.Effect<void>
}

/** A deadline bounds observers; only original executor exits permit resource cleanup. */
export const start = Effect.fnUntraced(function* <A, E>(
	owner: Scope.Scope,
	resources: Scope.Closeable,
	execute: Effect.Effect<A, E, Scope.Scope>,
	observe: (exit: Exit.Exit<A, E>) => Effect.Effect<void>,
): Effect.fn.Return<Execution<A, E>> {
	return yield* Effect.uninterruptible(
		Effect.gen(function* () {
			const workers = yield* Scope.make()
			const active = yield* FiberSet.make().pipe(Scope.provide(workers))
			yield* Scope.addFinalizer(resources, Release.close(workers, Exit.void))
			const run = Effect.fnUntraced(function* <B, F>(
				effect: Effect.Effect<B, F, Scope.Scope>,
			) {
				if (workers.state._tag === "Closed") return yield* Effect.interrupt
				const fiber = yield* Scope.provide(
					Effect.interruptible(effect),
					resources,
				).pipe(Effect.forkIn(owner, { startImmediately: false }))
				yield* FiberSet.add(active, fiber)
				return fiber
			}, Effect.uninterruptible)
			const fiber = yield* run(execute.pipe(Effect.onExit(observe)))
			const stop = Effect.uninterruptible(
				Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
			)
			const close = Effect.uninterruptible(
				Effect.gen(function* () {
					// Retain original fibers even if a concurrent close has already started.
					const executing = yield* Effect.sync(() => Array.fromIterable(active))
					const stopped = yield* Effect.exit(Release.close(workers, Exit.void))
					yield* Effect.forEach(executing, Fiber.await, { discard: true })
					yield* stop
					const released = yield* Effect.exit(
						Release.close(resources, Exit.void),
					)
					const cause = Cause.combine(
						Exit.isFailure(stopped) ? stopped.cause : Cause.empty,
						Exit.isFailure(released) ? released.cause : Cause.empty,
					)
					if (cause.reasons.length > 0) return yield* Effect.failCause(cause)
				}),
			)
			return { fiber, stop, run, close }
		}),
	)
})
