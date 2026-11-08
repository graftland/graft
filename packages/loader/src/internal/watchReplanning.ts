/** Waits for conflict evidence before asking the caller to prepare the latest revision again. */
import { Cause, Effect, HashSet, Option, Queue, Stream } from "effect"

import type { Kernel } from "@graftland/graft"
import type * as Control from "@graftland/plugin-remote/Control"

type Change = {
	readonly id: string
	readonly conclusion: Option.Option<unknown>
	readonly plan: Pick<Kernel.Status["plan"], "reads" | "writes">
}

/** How long a Busy revision waits for evidence before it is prepared again anyway. */
const fallback = "10 seconds"

/** A successful submission is never interrupted by an edit; only a rejected revision can be superseded. */
export const replanOnBusy = Effect.fnUntraced(function* <A, E, R>(
	changes: Stream.Stream<Change, Control.ControlError>,
	submit: Effect.Effect<A, Control.ControlError>,
	edited: Effect.Effect<unknown, E, R>,
) {
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const conclusions = yield* Queue.bounded<
				Change,
				Control.ControlError | Cause.Done
			>(64)
			// Subscribe before admission: the conflicting Change can finish before its Busy reply arrives.
			yield* changes.pipe(
				Stream.filter((status) => Option.isSome(status.conclusion)),
				Stream.runIntoQueue(conclusions),
				Effect.forkScoped({ startImmediately: true }),
			)
			return yield* submit.pipe(
				Effect.asSome,
				Effect.catchIf(
					(error) => error.reason === "Busy",
					(error) => {
						const conflicts = HashSet.fromIterable(error.conflicts ?? [])
						return Stream.fromQueue(conclusions).pipe(
							Stream.filter(
								(status) =>
									HashSet.size(conflicts) === 0 ||
									HashSet.has(conflicts, status.id) ||
									// The current kernel names reservation cells rather than Change ids.
									HashSet.some(
										conflicts,
										(key) =>
											HashSet.has(status.plan.reads, key) ||
											HashSet.has(status.plan.writes, key),
									),
							),
							Stream.runHead,
							Effect.raceFirst(edited),
							// Some owners release without a Change conclusion (a supervisor's member
							// restart): replan after a while even without evidence, so no edit is lost.
							Effect.timeoutOrElse({
								duration: fallback,
								orElse: () => Effect.void,
							}),
							Effect.as(Option.none<A>()),
						)
					},
				),
			)
		}),
	)
})
