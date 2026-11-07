import { Effect, Option, PubSub, Ref } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Candles, Quotes, type Candle } from "./services.ts"

export const candles = Plugin.make({
	name: "@graftland/sample-market-feed/candles",
	inject: [Quotes],
	apply: Effect.fn("candles.apply")(function* () {
		const quotes = yield* Quotes
		const input = yield* quotes.subscribe
		const output = yield* Effect.acquireRelease(
			PubSub.bounded<Candle>(16),
			PubSub.shutdown,
		)
		const current = yield* Ref.make(Option.none<Candle>())
		yield* Effect.addFinalizer(() =>
			Effect.log("candles: stopped; incomplete candle discarded"),
		)
		yield* Graft.provide(Candles, { subscribe: PubSub.subscribe(output) })
		yield* Plugin.fork(
			Effect.forever(
				Effect.gen(function* () {
					const quote = yield* PubSub.take(input)
					const minute = Math.floor(quote.at / 60_000)
					const previous = yield* Ref.get(current)
					if (Option.isSome(previous) && previous.value.minute === minute) {
						const candle = previous.value
						yield* Ref.set(
							current,
							Option.some({
								...candle,
								high: Math.max(candle.high, quote.price),
								low: Math.min(candle.low, quote.price),
								close: quote.price,
								ticks: candle.ticks + 1,
							}),
						)
					} else {
						if (Option.isSome(previous)) {
							yield* PubSub.publish(output, previous.value)
							yield* Effect.log("candles: closed", previous.value)
						}
						yield* Ref.set(
							current,
							Option.some({
								minute,
								open: quote.price,
								high: quote.price,
								low: quote.price,
								close: quote.price,
								ticks: 1,
							}),
						)
					}
					yield* Effect.log(`candles: accepted quote at ${quote.at}`)
				}),
			),
		)
		yield* Effect.log("candles: started")
	}),
})
