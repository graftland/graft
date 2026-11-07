import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashSet,
	Option,
	Ref,
	Scope,
	TxRef,
} from "effect"

import * as Change from "../Change"
import * as Release from "../Release"
import type { DriverError, Prepared } from "../Transition"
import * as AsyncClose from "./asyncClose"
import * as OwnedExecution from "./ownedExecution"
import type { Runtime } from "./runtime"
import type { Managed } from "./transition"

export interface Preparation {
	readonly state: Effect.Effect<AsyncClose.State>
	readonly value: Prepared
	readonly close: Effect.Effect<void>
	readonly await: Effect.Effect<Exit.Exit<void>>
}
interface Correlation {
	readonly instance: string
	readonly key?: string | undefined
}
/** The runtime-owned original close reports failure before its pending record is forgotten. */
const observeCleanup = (exit: Exit.Exit<void>, correlation: Correlation) =>
	(Exit.isFailure(exit)
		? Effect.logError("Change preparation cleanup failed", exit.cause)
		: Effect.void
	).pipe(Effect.annotateLogs({ ...correlation }))

type Execution = Deferred.Deferred<
	Option.Option<OwnedExecution.Execution<Prepared, DriverError>>
>
const closePreparation = Effect.fnUntraced(function* (
	started: Execution,
	resources: Scope.Closeable,
) {
	const loading = yield* Deferred.await(started)
	if (Option.isSome(loading)) yield* loading.value.close
	else yield* Release.close(resources, Exit.void)
})

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
					state: Effect.succeed({ _tag: "Completed", exit: Exit.void }),
					value: { overlap: managed.driver.overlap?.(candidate) === true },
					close: Effect.void,
					await: Effect.succeed(Exit.void),
				})
			const started =
				yield* Deferred.make<
					Option.Option<OwnedExecution.Execution<Prepared, DriverError>>
				>()
			const scope = yield* Scope.make()
			const owner: AsyncClose.Close = yield* AsyncClose.make(
				runtime.changes.cleanupScope,
				closePreparation(started, scope),
				(exit) =>
					observeCleanup(exit, { instance: managed.instance, key }).pipe(
						Effect.andThen(
							Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)
								? TxRef.update(
										runtime.changes.preparations,
										HashSet.remove(owner.dispose),
									)
								: Effect.void,
						),
					),
			)
			yield* Effect.tx(
				Effect.gen(function* () {
					if (!(yield* TxRef.get(runtime.changes.open)))
						return yield* Change.ChangeRejected.make({
							reason: { _tag: "Closing" },
						})
					yield* TxRef.update(
						runtime.changes.preparations,
						HashSet.add(owner.dispose),
					)
				}),
			).pipe(
				Effect.onExit((exit) =>
					Exit.isFailure(exit)
						? Deferred.succeed(started, Option.none()).pipe(
								Effect.andThen(owner.dispose),
							)
						: Effect.void,
				),
			)
			const load = managed.driver.prepare
			return yield* Effect.gen(function* () {
				const loading = yield* OwnedExecution.start(
					runtime.changes.scope,
					scope,
					Effect.suspend(() => load(candidate)),
					(exit) =>
						Exit.isFailure(exit)
							? Effect.logError(
									"Change metadata preparation failed",
									exit.cause,
								).pipe(Effect.annotateLogs({ instance: managed.instance, key }))
							: Effect.void,
				)
				yield* Deferred.succeed(started, Option.some(loading))
				const result = yield* Effect.exit(
					restore(
						Fiber.join(loading.fiber).pipe(Effect.timeout(limits.startup)),
					),
				)
				if (Exit.isSuccess(result))
					return yield* use({
						state: Ref.get(owner.state),
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
						: Deferred.succeed(started, Option.none()).pipe(
								Effect.andThen(owner.start),
								Effect.andThen(
									Cause.hasInterrupts(exit.cause)
										? Effect.gen(function* () {
												const cleanup = yield* Effect.timeoutOption(
													owner.await,
													limits.terminate,
												)
												if (
													Option.isSome(cleanup) &&
													Exit.isFailure(cleanup.value)
												)
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
