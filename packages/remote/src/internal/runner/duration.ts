import { Cause, Duration, Effect, Option } from "effect"
import { InvalidSessionRequest } from "./model"

/** Duration inputs may be malformed at JavaScript or configuration boundaries. */
export const milliseconds = (input: Duration.Input) =>
	Duration.fromInput(input).pipe(
		Option.map(Duration.toMillis),
		Option.filter((value) => Number.isFinite(value) && value > 0),
		Effect.fromOption,
		Effect.mapError(() =>
			InvalidSessionRequest.make({
				detail: "Runner durations must be finite and positive",
				cause: Cause.empty,
			}),
		),
	)
