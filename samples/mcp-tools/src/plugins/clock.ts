import { Clock, DateTime, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

import { plugin as tools } from "@graftland/plugin-mcp-server/Tools"

const ClockTools = Toolkit.make(
	Tool.make("current_time", {
		description: "The current time, as an ISO 8601 string in UTC.",
		success: Schema.String,
	}),
)

// Edit this handler while a client is connected: the next call runs the new code.
export default tools({
	name: "@graftland/sample-mcp-tools/plugins/clock",
	toolkit: ClockTools,
	handlers: Effect.succeed(
		ClockTools.of({
			current_time: () =>
				Effect.map(Clock.currentTimeMillis, (millis) =>
					DateTime.formatIso(DateTime.makeUnsafe(millis)),
				),
		}),
	),
})
