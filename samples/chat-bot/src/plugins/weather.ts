import { Array, Cause, Effect, Option } from "effect"

import { Plugin } from "@graftland/graft"

import { command } from "../Chat.ts"
import { Forecasts } from "../Forecasts.ts"

/**
 * `/weather <city>`. It declares `Forecasts` in `inject`, so it only exists
 * while a forecasts provider is loaded; nothing here checks for that.
 */
export default Plugin.make({
	name: "weather",
	inject: [Forecasts],
	apply: Effect.fn("weather.apply")(function* () {
		const forecasts = yield* Forecasts
		yield* command(
			"weather",
			"today's weather, such as /weather Paris",
			({ args }) => {
				const city = Array.join(args, " ")
				return Effect.map(forecasts.today(city), (forecast) =>
					Option.match(forecast, {
						onNone: () => `No forecast for "${city}".`,
						onSome: (forecast) => `${city}: ${forecast}`,
					}),
				).pipe(
					Effect.catchTag("ForecastUnavailable", (error) =>
						Effect.logWarning("Weather lookup failed", Cause.fail(error)).pipe(
							Effect.as("Weather is temporarily unavailable."),
						),
					),
				)
			},
		)
	}),
})
