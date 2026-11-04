import { Cause, Data, Effect, FiberSet, TxRef } from "effect"
import type { Fiber, Scope } from "effect"

type State<E> = Data.TaggedEnum<{
	Open: {}
	Failed: { readonly cause: Cause.Cause<E> }
	Closed: {}
}>
interface StateDefinition extends Data.TaggedEnum.WithGenerics<1> {
	readonly taggedEnum: State<this["A"]>
}
const State = Data.taggedEnum<StateDefinition>()
export interface FailureGroup<E> {
	readonly await: Effect.Effect<never, E>
	readonly check: Effect.Effect<void, E>
	readonly cause: Effect.Effect<Cause.Cause<E>>
	readonly run: <A, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<Fiber.Fiber<A, E>, never, R>
	readonly fail: (error: E) => Effect.Effect<void>
	readonly failCause: (cause: Cause.Cause<E>) => Effect.Effect<void>
	readonly race: <A, E2, R>(
		effect: Effect.Effect<A, E2, R>,
	) => Effect.Effect<A, E | E2, R>
	readonly runtime: <R>() => Effect.Effect<
		(effect: Effect.Effect<unknown, E, R>) => Fiber.Fiber<unknown, E>,
		never,
		R
	>
	readonly close: Effect.Effect<void>
}

/** One owner for first failure, transaction wakeups, and interruption of sibling work. */
export const make = <E>(): Effect.Effect<FailureGroup<E>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const fibers = yield* FiberSet.make<unknown, E>()
		const state = yield* TxRef.make<State<E>>(State.Open())
		const check = TxRef.get(state).pipe(
			Effect.flatMap((s) =>
				s._tag === "Failed"
					? Effect.failCause(s.cause)
					: s._tag === "Closed"
						? Effect.interrupt
						: Effect.void,
			),
		)
		const publish = (cause: Cause.Cause<E>) =>
			TxRef.update(state, (s): State<E> =>
				s._tag === "Open" ? State.Failed({ cause }) : s,
			)
		yield* FiberSet.join(fibers).pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.void
					: publish(cause).pipe(
							Effect.andThen(FiberSet.clear(fibers)),
							Effect.uninterruptible,
						),
			),
			Effect.forkScoped,
		)
		const failure = Effect.tx(check.pipe(Effect.andThen(Effect.txRetry)))
		const failCause = (cause: Cause.Cause<E>) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.void
				: publish(cause).pipe(
						Effect.andThen(FiberSet.run(fibers, Effect.failCause(cause))),
						Effect.asVoid,
					)
		return {
			await: failure,
			check,
			cause: TxRef.get(state).pipe(
				Effect.map((s) => (s._tag === "Failed" ? s.cause : Cause.empty)),
			),
			runtime: <R>() => FiberSet.runtime(fibers)<R>(),
			run: (effect) =>
				FiberSet.run(
					fibers,
					check.pipe(
						Effect.andThen(effect),
						Effect.tapCause((cause) =>
							Cause.hasInterruptsOnly(cause) ? Effect.void : publish(cause),
						),
					),
				),
			fail: (error) => failCause(Cause.fail(error)),
			failCause,
			race: (effect) =>
				check.pipe(Effect.andThen(Effect.raceFirst(effect, failure))),
			close: TxRef.update(state, (s) =>
				s._tag === "Open" ? State.Closed() : s,
			).pipe(Effect.andThen(FiberSet.clear(fibers))),
		}
	})
