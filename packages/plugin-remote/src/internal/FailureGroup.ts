import {
	Array,
	Cause,
	Data,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Ref,
	Schema,
	Scope,
	TxRef,
} from "effect"

import * as Finalization from "@graftland/graft/Finalization"

import { cleanupCause } from "./cleanup"

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
		options?: { readonly startImmediately?: boolean },
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
	readonly close: Effect.Effect<void, E>
}

/** One owner for first failure, transaction wakeups, and interruption of sibling work. */
export const make = Effect.fnUntraced(function* <E>(): Effect.fn.Return<
	FailureGroup<E>,
	never,
	Scope.Scope
> {
	const fibers = yield* FiberSet.make<unknown, E>()
	const state = yield* TxRef.make<State<E>>(State.Open())
	const failures = yield* Ref.make<Cause.Cause<E>>(Cause.empty)
	const cleanup = yield* Ref.make<Cause.Cause<E>>(Cause.empty)
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

	const observe = <A, R>(
		effect: Effect.Effect<A, E, R>,
		options?: { readonly startImmediately?: boolean },
	) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const scope = yield* Scope.make()
				// The owned child makes cancellation explicit, even when a stream closes an internal scope.
				const ownerId = yield* Effect.withFiber((self) =>
					Effect.succeed(self.id),
				)
				const worker = yield* Effect.forkIn(
					restore(Scope.provide(scope)(effect)),
					scope,
					options,
				)
				const waiting = yield* Effect.exit(restore(Fiber.await(worker)))
				if (Exit.isFailure(waiting)) yield* Fiber.interrupt(worker)
				const body = yield* Fiber.await(worker)
				const closed = yield* Effect.exit(Finalization.close(scope, body))
				// Forwarding this exact cancellation from a finalizer is indistinguishable from acknowledging it.
				const expected =
					Exit.isFailure(waiting) &&
					Exit.isFailure(body) &&
					Array.every(
						body.cause.reasons,
						(reason) =>
							reason._tag === "Interrupt" && reason.fiberId === ownerId,
					)
				const bodyCause =
					Exit.isFailure(body) && !expected ? body.cause : Cause.empty
				// Finalization.close marks independent interruptions; an unmarked one is pending cancellation.
				const releaseCause =
					Exit.isFailure(closed) && !Cause.hasInterruptsOnly(closed.cause)
						? closed.cause
						: Cause.empty
				const failure = Cause.combine(bodyCause, releaseCause)
				// Body cleanup may carry either an interruption or a release defect from an inner group.
				const closing = Cause.combine(
					Cause.hasInterrupts(bodyCause) ||
						Array.some(
							bodyCause.reasons,
							(reason) =>
								reason._tag === "Die" &&
								Schema.is(Finalization.FinalizationInterrupted)(reason.defect),
						)
						? bodyCause
						: Cause.empty,
					releaseCause,
				)
				yield* Ref.update(cleanup, (cause) => Cause.combine(cause, closing))
				if (failure.reasons.length > 0) {
					yield* Ref.update(failures, (cause) => Cause.combine(cause, failure))
					yield* publish(failure)
					yield* Deferred.failCause(fibers.deferred, failure)
				}
				if (Exit.isFailure(closed))
					return yield* Effect.failCause(
						Exit.isFailure(body)
							? Cause.combine(body.cause, closed.cause)
							: closed.cause,
					)
				if (Exit.isFailure(waiting) && Exit.isSuccess(body))
					return yield* Effect.failCause(waiting.cause)
				return yield* body
			}),
		)
	yield* FiberSet.join(fibers).pipe(
		Effect.catchCause((cause) =>
			publish(cause).pipe(
				Effect.andThen(FiberSet.clear(fibers)),
				Effect.uninterruptible,
			),
		),
		Effect.forkScoped,
	)
	const failure = Effect.tx(check.pipe(Effect.andThen(Effect.txRetry)))
	const failCause = (cause: Cause.Cause<E>) =>
		// This is an explicit failure report, not cancellation of an owned worker.
		FiberSet.run(fibers, observe(Effect.failCause(cause))).pipe(Effect.asVoid)
	const close = TxRef.update(state, (s) =>
		s._tag === "Open" ? State.Closed() : s,
	).pipe(
		Effect.andThen(FiberSet.clear(fibers)),
		Effect.andThen(Ref.get(cleanup)),
		Effect.flatMap((cause) =>
			cause.reasons.length > 0 ? Effect.failCause(cause) : Effect.void,
		),
		Effect.uninterruptible,
	)
	// Operational failure is delivered by await; release must also deliver sibling cleanup failures.
	// Every sibling failure and interruption survives as a defect; orDie would keep only the first failure.
	yield* Effect.addFinalizer(() =>
		close.pipe(
			Effect.catchCause((cause) => Effect.failCause(cleanupCause(cause))),
		),
	)
	return {
		await: failure,
		check,
		cause: Ref.get(failures),
		runtime: <R>() =>
			FiberSet.runtime(fibers)<R>().pipe(
				Effect.map(
					(run) => (effect: Effect.Effect<unknown, E, R>) =>
						run(check.pipe(Effect.andThen(observe(effect)))),
				),
			),
		run: (effect, options) =>
			FiberSet.run(
				fibers,
				check.pipe(Effect.andThen(observe(effect, options))),
			),
		fail: (error) => failCause(Cause.fail(error)),
		failCause,
		race: (effect) =>
			check.pipe(Effect.andThen(Effect.raceFirst(effect, failure))),
		close,
	}
})
