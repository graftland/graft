import { Deferred, Effect, Exit, Fiber, Scope } from "effect"

export type Finalizer = "masked" | "interruptible" | "self" | "joined"
export type Close = (
	scope: Scope.Closeable,
	exit: Exit.Exit<unknown, unknown>,
) => Effect.Effect<void>

interface Observation {
	readonly before: Exit.Exit<void>
	readonly closed: Exit.Exit<void>
	readonly pending: Exit.Exit<void>
}

// Gates establish the cancellation order; they do not implement a runtime state machine.
export const observeClose = Effect.fnUntraced(function* (
	close: Close,
	finalizer: Finalizer,
	timing: "before failure" | "after failure" = "before failure",
) {
	const canceller = yield* Effect.withFiber((self) => Effect.succeed(self.id))
	const child = yield* Effect.forkScoped(Effect.never)
	yield* Fiber.interrupt(child)
	const childExit = yield* Fiber.await(child)
	const entered = yield* Deferred.make<void>()
	const resume = yield* Deferred.make<void>()
	const observed = yield* Deferred.make<Observation>()
	const scope = yield* Scope.make()
	const gate = Deferred.succeed(entered, undefined).pipe(
		Effect.andThen(Deferred.await(resume)),
	)
	const cleanup =
		finalizer === "masked"
			? Effect.void
			: finalizer === "interruptible"
				? Effect.interruptible(Effect.void)
				: finalizer === "self"
					? Effect.interrupt
					: Fiber.join(child)
	if (timing === "after failure") {
		// Sequential finalizers run in reverse registration order.
		yield* Scope.addFinalizer(scope, gate)
		yield* Scope.addFinalizer(scope, cleanup)
	} else {
		yield* Scope.addFinalizer(scope, gate.pipe(Effect.andThen(cleanup)))
	}
	const closer = yield* Effect.gen(function* () {
		const before = yield* Effect.exit(Effect.interruptible(Effect.void))
		const closed = yield* Effect.exit(close(scope, Exit.void))
		const pending = yield* Effect.exit(Effect.interruptible(Effect.void))
		yield* Deferred.succeed(observed, { before, closed, pending })
		return yield* closed
	}).pipe(Effect.uninterruptible, Effect.forkScoped)
	yield* Deferred.await(entered)
	const cancellation = yield* Fiber.interruptAs(closer, canceller).pipe(
		Effect.forkScoped({ startImmediately: true }),
	)
	yield* Deferred.succeed(resume, undefined)
	const observation = yield* Deferred.await(observed)
	yield* Fiber.join(cancellation)
	const outer = yield* Fiber.await(closer)
	return { ...observation, outer, childExit, canceller, closer: closer.id }
}, Effect.scoped)
