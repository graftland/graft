import { Duration, Schema } from "effect"

export const PositiveDuration = Schema.DurationFromString.check(
	Schema.makeFilter(
		(value) => Duration.isFinite(value) && Duration.toMillis(value) > 0,
		{ expected: "a finite, positive duration" },
	),
)
