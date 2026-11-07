import { Array, Data, Effect } from "effect"

import type { Change } from "@graftland/graft"

import type { Applied } from "../Model"

type Progress<A> = Data.TaggedEnum<{
	Applying: {
		readonly accepted: ReadonlyArray<A>
		readonly outcomes: Applied["outcomes"]
	}
	Rejected: {
		readonly degraded: boolean
		readonly outcomes: Applied["outcomes"]
	}
}>
const Progress = Data.taggedEnum<Progress<unknown>>()

/** A failed entry closes forward execution; compensation visits every accepted entry in reverse. */
export const execute = <A, E, R>(
	work: ReadonlyArray<A>,
	id: (item: A) => string,
	transition: (
		item: A,
		compensation: boolean,
	) => Effect.Effect<Change.Outcome, E, R>,
) =>
	Effect.reduce(
		work,
		(): Progress<A> => ({ _tag: "Applying", accepted: [], outcomes: [] }),
		Effect.fnUntraced(function* (progress, item): Effect.fn.Return<
			Progress<A>,
			E,
			R
		> {
			if (progress._tag === "Rejected") return progress
			const outcome = yield* transition(item, false)
			const outcomes = [
				...progress.outcomes,
				{ entry: id(item), compensation: false, outcome },
			]
			if (outcome._tag === "Accepted")
				return {
					_tag: "Applying",
					accepted: [...progress.accepted, item],
					outcomes,
				}
			return yield* Effect.reduce(
				Array.reverse(progress.accepted),
				() =>
					Progress.Rejected({
						outcomes,
						degraded:
							outcome._tag === "RecoveryFailed" || outcome._tag === "Stuck",
					}),
				Effect.fnUntraced(function* (rejected, item) {
					const outcome = yield* transition(item, true)
					return Progress.Rejected({
						outcomes: [
							...rejected.outcomes,
							{ entry: id(item), compensation: true, outcome },
						],
						degraded: rejected.degraded || outcome._tag !== "Accepted",
					})
				}),
			)
		}),
	)
