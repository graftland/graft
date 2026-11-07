import { Deferred, Effect, FileSystem, Schedule } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { config, Forecast, service } from "@example/forecast-contract"

export default Plugin.make({
	name: "@example/forecasts-broken-probe",
	config,
	provides: [service],
	overlap: true,
	inject: [FileSystem.FileSystem],
	apply: Effect.fnUntraced(function* (input) {
		const fs = yield* FileSystem.FileSystem
		const crashed = yield* Deferred.make<void>()
		yield* Plugin.probe("health", Effect.fail("Forecast probe failed"))
		yield* Plugin.fork(
			Deferred.await(crashed).pipe(
				Effect.andThen(Effect.fail("Forecast trial failed")),
			),
		)
		yield* Graft.provide(Forecast, {
			get: Effect.fnUntraced(function* (city) {
				if (city === "crash" && false)
					yield* Deferred.succeed(crashed, undefined)
				if (city === "slow") {
					yield* fs
						.writeFileString(input.started, "admitted")
						.pipe(Effect.orDie)
					yield* fs.exists(input.release).pipe(
						Effect.repeat({
							schedule: Schedule.spaced("10 millis"),
							until: (exists) => exists,
						}),
						Effect.orDie,
					)
				}
				return "v2 forecast for " + city
			}),
		})
	}),
})
