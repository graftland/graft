import {
	Cause,
	Data,
	Effect,
	Exit,
	HashSet,
	Option,
	Scope,
	TxRef,
} from "effect"

import * as Change from "../Change"
import * as Release from "../Release"
import type { Prepared } from "../Transition"
import type { Runtime } from "./runtime"
import type { Managed } from "./transition"

type ReleaseState = Data.TaggedEnum<{
	Pending: {}
	Running: {}
	Completed: { readonly exit: Exit.Exit<void> }
}>
const ReleaseState = Data.taggedEnum<ReleaseState>()
export interface Preparation {
	readonly value: Prepared
	readonly close: Effect.Effect<void>
	readonly await: Effect.Effect<Exit.Exit<void>>
}

/** Metadata cleanup retains the original close result, including ambiguous interruption. */
export const prepare = Effect.fnUntraced(function* (
	runtime: Runtime,
	managed: Managed,
	candidate: Change.Candidate,
	limit: number,
) {
	if (managed.driver.prepare === undefined)
		return {
			value: { overlap: managed.driver.overlap?.(candidate) === true },
			close: Effect.void,
			await: Effect.succeed(Exit.void),
		} satisfies Preparation
	const scope = yield* Scope.make()
	const state = yield* TxRef.make<ReleaseState>(ReleaseState.Pending())
	const claim = Effect.tx(
		TxRef.modify(state, (current) =>
			current._tag === "Pending"
				? [true, ReleaseState.Running()]
				: [false, current],
		),
	)
	const completed = Effect.tx(
		TxRef.get(state).pipe(
			Effect.flatMap((current) =>
				current._tag === "Completed"
					? Effect.succeed(current.exit)
					: Effect.txRetry,
			),
		),
	)
	const finish = Effect.uninterruptible(
		Effect.gen(function* () {
			const exit = yield* Effect.exit(Release.close(scope, Exit.void))
			yield* TxRef.set(state, ReleaseState.Completed({ exit }))
			if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause))
				yield* TxRef.update(
					runtime.changes.preparations,
					HashSet.remove(dispose),
				)
		}),
	)
	const dispose: Effect.Effect<void> = Effect.uninterruptible(
		Effect.gen(function* () {
			if (yield* claim) yield* finish
			const exit = yield* completed
			if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
		}),
	)
	yield* TxRef.update(runtime.changes.preparations, HashSet.add(dispose))
	const close = Effect.uninterruptible(
		claim.pipe(
			Effect.flatMap((owner) =>
				owner
					? Effect.forkIn(finish, runtime.changes.scope, {
							uninterruptible: true,
						}).pipe(Effect.asVoid)
					: Effect.void,
			),
		),
	)

	const prepareCandidate = managed.driver.prepare
	const result = yield* Effect.exit(
		Scope.provide(
			prepareCandidate === undefined
				? Effect.succeed({
						overlap: managed.driver.overlap?.(candidate) === true,
					})
				: Effect.suspend(() => prepareCandidate(candidate)),
			scope,
		).pipe(Effect.timeout(limit)),
	)
	if (Exit.isSuccess(result))
		return {
			value: result.value,
			close,
			await: completed,
		} satisfies Preparation
	yield* close
	const cleanup = yield* Effect.timeoutOption(completed, limit)
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
})
