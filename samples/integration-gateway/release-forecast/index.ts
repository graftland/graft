import { Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { config, Forecast, service } from "@example/forecast-contract"

export default Plugin.make({
	name: "@example/forecasts-release",
	config,
	provides: [service],
	overlap: true,
	apply: Effect.fnUntraced(function* (input) {
		yield* Plugin.probe(
			"health",
			input.holdProbe === true
				? Effect.never
				: input.unhealthy === true
					? Effect.fail("Forecast credentials rejected")
					: Effect.void,
		)
		yield* Graft.provide(Forecast, {
			get: (city) =>
				Effect.succeed((input.prefix ?? "initial") + " forecast for " + city),
		})
	}),
})
