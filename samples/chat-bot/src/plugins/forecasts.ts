import { Graft, Plugin } from "@graftland/graft"
import { Effect, Option, Record, String } from "effect"
import { config } from "../forecastContract.ts"
import { Forecasts } from "../Forecasts.ts"

// Stands in for a weather API client; a real one would open its HTTP client here.
const table: Record<
	string,
	{ readonly sky: string; readonly celsius: number }
> = {
	paris: { sky: "light rain", celsius: 14 },
	tokyo: { sky: "clear", celsius: 21 },
	reykjavik: { sky: "snow", celsius: -3 },
}

/** Publishes `Forecasts`. Every plugin that injects it waits for this one. */
export default Plugin.make({
	name: "forecasts",
	config,
	apply: ({ units }) =>
		Effect.gen(function* () {
			yield* Effect.acquireRelease(
				Effect.log(`Connected to the weather service (${units})`),
				() => Effect.log("Disconnected from the weather service"),
			)
			yield* Graft.provide(Forecasts, {
				today: (city) =>
					Effect.succeed(
						Option.map(
							Record.get(table, String.toLowerCase(city)),
							({ sky, celsius }) =>
								units === "celsius"
									? `${sky}, ${celsius} °C`
									: `${sky}, ${Math.round((celsius * 9) / 5 + 32)} °F`,
						),
					),
			})
		}),
})
