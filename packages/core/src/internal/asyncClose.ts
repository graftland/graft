import { Deferred, Effect, Exit, Ref, Scope } from "effect"

export type State =
	| { readonly _tag: "Pending" }
	| { readonly _tag: "Running" }
	| { readonly _tag: "Completed"; readonly exit: Exit.Exit<void> }
export interface Close {
	readonly state: Ref.Ref<State>
	readonly start: Effect.Effect<void>
	readonly await: Effect.Effect<Exit.Exit<void>>
	readonly dispose: Effect.Effect<void>
}

/** One owner runs close; every observer receives its original Exit, including interruption. */
export const make = Effect.fnUntraced(function* (
	owner: Scope.Scope,
	close: Effect.Effect<void>,
	afterClose: (exit: Exit.Exit<void>) => Effect.Effect<void> = () =>
		Effect.void,
): Effect.fn.Return<Close> {
	const state = yield* Ref.make<State>({ _tag: "Pending" })
	const completed = yield* Deferred.make<Exit.Exit<void>>()
	const claim = Ref.modify(state, (current): readonly [boolean, State] =>
		current._tag === "Pending" ? [true, { _tag: "Running" }] : [false, current],
	)
	const finish = Effect.uninterruptible(
		Effect.exit(close).pipe(
			Effect.flatMap((exit) =>
				afterClose(exit).pipe(
					Effect.catchCause((cause) =>
						Effect.logError(
							"Asynchronous close completion observer failed",
							cause,
						),
					),
					Effect.ensuring(
						Ref.set(state, { _tag: "Completed", exit }).pipe(
							Effect.andThen(Deferred.succeed(completed, exit)),
						),
					),
				),
			),
		),
	)
	// Claim only once an executor is running; a fork into a closed owner cannot strand Running.
	const run = Effect.uninterruptible(
		claim.pipe(Effect.flatMap((owns) => (owns ? finish : Effect.void))),
	)
	return {
		state,
		start: Effect.uninterruptible(
			Effect.suspend(() =>
				owner.state._tag === "Closed"
					? run
					: Effect.forkIn(run, owner, { uninterruptible: true }).pipe(
							Effect.asVoid,
						),
			),
		),
		await: Deferred.await(completed),
		// Shutdown may already be closing the owner, so an unstarted close runs inline.
		dispose: Effect.uninterruptible(
			Effect.gen(function* () {
				yield* run
				const exit = yield* Deferred.await(completed)
				if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
			}),
		),
	}
})
