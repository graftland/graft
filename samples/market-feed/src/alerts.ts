import { Plugin } from "@graftland/graft"
import { Effect, Option, PubSub } from "effect"
import { Candles, Notifier } from "./services.ts"

export const alerts = Plugin.make({
	name: "alerts",
	inject: [Candles, Plugin.optional(Notifier)],
	apply: () =>
		Effect.gen(function* () {
			const candles = yield* Candles
			const notifier = yield* Effect.serviceOption(Notifier)
			const input = yield* candles.subscribe
			const mode = Option.isSome(notifier) ? "webhook" : "log only"
			yield* Effect.addFinalizer(() => Effect.log(`alerts: stopped (${mode})`))
			yield* Plugin.fork(
				Effect.forever(
					Effect.gen(function* () {
						const candle = yield* PubSub.take(input)
						if (candle.close >= candle.open * 1.01) {
							const message = `BTC-USD minute ${candle.minute}: rose at least 1% (${candle.open} -> ${candle.close})`
							yield* Effect.log(`alerts: ${message}`)
							if (Option.isSome(notifier)) yield* notifier.value.send(message)
						} else {
							yield* Effect.log(
								`alerts: minute ${candle.minute} stayed below the 1% threshold`,
							)
						}
					}),
				),
			)
			yield* Effect.log(`alerts: started (${mode})`)
		}),
})
