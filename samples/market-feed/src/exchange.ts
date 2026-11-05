import { Effect, PubSub, Schedule } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { ExchangeTransport, Quotes, type Quote } from "./services.ts"

export const exchange = Plugin.make({
	name: "exchange",
	inject: [ExchangeTransport],
	retry: Schedule.exponential("400 millis"),
	apply: Effect.fn("exchange.apply")(function* () {
		const transport = yield* ExchangeTransport
		const connection = yield* transport.connect
		const quotes = yield* Effect.acquireRelease(
			PubSub.bounded<Quote>(16),
			PubSub.shutdown,
		)
		yield* Graft.provide(Quotes, { subscribe: PubSub.subscribe(quotes) })
		yield* Plugin.fork(
			Effect.forever(
				Effect.flatMap(connection.read, (quote) =>
					PubSub.publish(quotes, quote),
				),
			),
		)
		yield* Effect.log("exchange: started")
	}),
})
