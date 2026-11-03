import { Plugin } from "@graftland/graft"
import { Duration, Effect, Schedule, Schema } from "effect"

// Logs a tick every few seconds, until its entry is removed or disabled.
export default Plugin.make({
	name: "ticker",
	config: Schema.Struct({ seconds: Schema.Int }),
	apply: ({ seconds }) =>
		Effect.log("tick").pipe(
			Effect.repeat(Schedule.spaced(Duration.seconds(seconds))),
			Plugin.fork,
			Effect.asVoid,
		),
})
