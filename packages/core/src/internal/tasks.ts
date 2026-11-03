import { Cause, Effect, Exit, FiberSet, Ref, Scope } from "effect"

// This requirement carries asynchronous errors to Plugin.make; it has no public service key.
declare const TaskErrors: unique symbol
export interface Tasks<out E> {
	readonly [TaskErrors]: E
}
export type Errors<R> = R extends Tasks<infer E> ? E : never

/** One activation owns both the workers and every failure they finish with. */
export const make = Effect.gen(function* () {
	const scope = yield* Scope.make()
	const fibers = yield* FiberSet.make<unknown, unknown>().pipe(
		Scope.provide(scope),
	)
	const failures = yield* Ref.make<Cause.Cause<unknown>>(Cause.empty)
	return { scope, fibers, failures }
})
export type Group = Effect.Success<typeof make>

export const run = <A, E, R>(group: Group, effect: Effect.Effect<A, E, R>) =>
	FiberSet.run(
		group.fibers,
		Effect.scoped(effect).pipe(
			Effect.onExit((exit) =>
				Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
					? Ref.update(group.failures, (cause) =>
							Cause.combine(cause, exit.cause),
						).pipe(
							Effect.andThen(
								Effect.logError(
									"The plugin's background task failed",
									exit.cause,
								),
							),
						)
					: Effect.void,
			),
		),
		{ startImmediately: false },
	)
