import { Array, Data, Effect, Option } from "effect"

import type { Change } from "@graftland/graft"

import { Observation, type Applied, type ReleaseError } from "../Model"

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
const accepted = (observation: Observation) =>
	observation._tag === "Admitted" && observation.outcome._tag === "Accepted"
const degraded = (observation: Observation) =>
	observation._tag === "Admitted" &&
	(observation.outcome._tag === "RecoveryFailed" ||
		observation.outcome._tag === "Stuck")

/** A rejection closes forward execution just like an unaccepted admitted outcome. */
export const execute = <A, R>(
	work: ReadonlyArray<A>,
	id: (item: A) => string,
	transition: (
		item: A,
		compensation: boolean,
		expected: number | undefined,
	) => Effect.Effect<Change.Outcome, ReleaseError | Change.ChangeRejected, R>,
	observe: (
		observation: Observation,
	) => Effect.Effect<void, ReleaseError, R> = () => Effect.void,
) => {
	const attempt = Effect.fnUntraced(function* (
		item: A,
		compensation: boolean,
		expected: number | undefined,
	) {
		const observation = yield* transition(item, compensation, expected).pipe(
			Effect.map((outcome) =>
				Observation.Admitted({ entry: id(item), compensation, outcome }),
			),
			Effect.catchTag("ChangeRejected", (rejection) =>
				Effect.succeed(
					Observation.Rejected({ entry: id(item), compensation, rejection }),
				),
			),
		)
		yield* observe(observation)
		return observation
	})
	return Effect.reduce(
		work,
		(): Progress<A> => ({ _tag: "Applying", accepted: [], outcomes: [] }),
		Effect.fnUntraced(function* (progress, item): Effect.fn.Return<
			Progress<A>,
			ReleaseError,
			R
		> {
			if (progress._tag === "Rejected") return progress
			const observation = yield* attempt(item, false, undefined)
			const outcomes = Array.append(progress.outcomes, observation)
			if (accepted(observation))
				return {
					_tag: "Applying",
					accepted: Array.append(progress.accepted, item),
					outcomes,
				}
			return yield* Effect.reduce(
				Array.reverse(progress.accepted),
				() => Progress.Rejected({ outcomes, degraded: degraded(observation) }),
				Effect.fnUntraced(function* (rejected, item) {
					const previous = Option.getOrThrow(
						Array.findFirst(
							progress.outcomes,
							(itemObservation) =>
								itemObservation.entry === id(item) && accepted(itemObservation),
						),
					)
					if (previous._tag !== "Admitted")
						return yield* Effect.die(
							new Error("Compensation requires an admitted accepted Change"),
						)
					const member = Option.getOrThrow(
						Array.findFirst(
							previous.outcome.members,
							(member) => member.instance === id(item),
						),
					)
					const observation = yield* attempt(item, true, member.actual.version)
					return Progress.Rejected({
						outcomes: Array.append(rejected.outcomes, observation),
						degraded: rejected.degraded || !accepted(observation),
					})
				}),
			)
		}),
	)
}
