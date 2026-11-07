import { Cause, Effect, Exit, HashSet, Option, Scope, TxRef } from "effect"

import * as Change from "../Change"
import * as Release from "../Release"
import type { Prepared } from "../Transition"
import * as AsyncClose from "./asyncClose"
import type { Runtime } from "./runtime"
import type { Managed } from "./transition"

export interface Preparation {
	readonly value: Prepared
	readonly close: Effect.Effect<void>
	readonly await: Effect.Effect<Exit.Exit<void>>
}
export interface Correlation {
	readonly instance: string
	readonly key?: string | undefined
	readonly change?: Change.Id | undefined
}
export const observeCleanup = (
	runtime: Runtime,
	completed: Preparation["await"],
	correlation: Correlation,
) =>
	completed.pipe(
		Effect.flatMap((exit) =>
			Exit.isFailure(exit)
				? Effect.logError("Change preparation cleanup failed", exit.cause)
				: Effect.void,
		),
		Effect.annotateLogs({ ...correlation }),
		Effect.forkIn(runtime.changes.scope, { uninterruptible: true }),
		Effect.asVoid,
	)

/** Preparation and its admission handoff share one interruption-safe resource boundary. */
export const prepare = Effect.fnUntraced(function* <A, E, R>(
	runtime: Runtime,
	managed: Managed,
	candidate: Change.Candidate,
	limits: { readonly startup: number; readonly terminate: number },
	use: (preparation: Preparation) => Effect.Effect<A, E, R>,
	key?: string,
): Effect.fn.Return<A, E | Change.ChangeRejected, R> {
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			if (managed.driver.prepare === undefined)
				return yield* use({
					value: { overlap: managed.driver.overlap?.(candidate) === true },
					close: Effect.void,
					await: Effect.succeed(Exit.void),
				})
			const scope = yield* Scope.make()
			const owner: AsyncClose.Close = yield* AsyncClose.make(
				runtime.changes.scope,
				Release.close(scope, Exit.void),
				(exit) =>
					Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)
						? TxRef.update(
								runtime.changes.preparations,
								HashSet.remove(owner.dispose),
							)
						: Effect.void,
			)
			yield* TxRef.update(
				runtime.changes.preparations,
				HashSet.add(owner.dispose),
			)
			const load = managed.driver.prepare
			return yield* Effect.gen(function* () {
				const result = yield* Effect.exit(
					restore(
						Scope.provide(
							Effect.suspend(() => load(candidate)),
							scope,
						).pipe(Effect.timeout(limits.startup)),
					),
				)
				if (Exit.isSuccess(result))
					return yield* use({
						value: result.value,
						close: owner.start,
						await: owner.await,
					})
				if (Cause.hasInterrupts(result.cause))
					return yield* Effect.failCause(
						Cause.map(result.cause, (error) =>
							Change.ChangeRejected.make({
								reason: {
									_tag: "Unsupported",
									message: "Candidate metadata preparation failed",
								},
								cause: Cause.fail(error),
							}),
						),
					)
				yield* owner.start
				const cleanup = yield* Effect.timeoutOption(
					owner.await,
					limits.terminate,
				)
				return yield* Change.ChangeRejected.make({
					reason: {
						_tag: "Unsupported",
						message: "Candidate metadata preparation failed",
					},
					cause: Cause.combine(
						result.cause,
						Option.isSome(cleanup) && Exit.isFailure(cleanup.value)
							? cleanup.value.cause
							: Cause.empty,
					),
				})
			}).pipe(
				Effect.onExit((exit) =>
					Exit.isSuccess(exit)
						? Effect.void
						: owner.start.pipe(
								Effect.andThen(
									Cause.hasInterrupts(exit.cause)
										? Effect.gen(function* () {
												const cleanup = yield* Effect.timeoutOption(
													owner.await,
													limits.terminate,
												)
												if (Option.isNone(cleanup))
													yield* observeCleanup(runtime, owner.await, {
														instance: managed.instance,
														key,
													})
												else if (Exit.isFailure(cleanup.value))
													return yield* Effect.failCause(cleanup.value.cause)
											})
										: Effect.void,
								),
							),
				),
			)
		}),
	)
})
