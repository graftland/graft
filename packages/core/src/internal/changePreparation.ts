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
	yield* TxRef.update(runtime.changes.preparations, HashSet.add(owner.dispose))
	const close = owner.start
	const completed = owner.await

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
