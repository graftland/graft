import { Cause, Effect, Layer, Logger } from "effect"
import { NodeRuntime } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

import { alerts } from "./alerts.ts"
import { candles } from "./candles.ts"
import { exchange } from "./exchange.ts"
import { notifier } from "./notifier.ts"
import { printSnapshot, reach, waitForLog } from "./observe.ts"
import { makeScriptedExchange } from "./scripted-exchange.ts"
import { ExchangeTransport, ExchangeUnavailable } from "./services.ts"

const demo = Effect.gen(function* () {
	const venue = yield* makeScriptedExchange
	yield* Graft.provide(ExchangeTransport, venue.transport)

	yield* Effect.log(
		"--- 1. Load consumers before the exchange. Graft waits for their services ---",
	)
	const bars = yield* Graft.plugin(candles)
	const signals = yield* Graft.plugin(alerts)
	yield* reach(bars, "Pending")
	yield* reach(signals, "Pending")
	yield* printSnapshot("Waiting for the feed")

	yield* Effect.log(
		"--- 2. Connect the exchange. Publishing Quotes starts the whole pipeline ---",
	)
	const feed = yield* Graft.plugin(exchange)
	yield* reach(feed, "Active")
	yield* reach(bars, "Active")
	yield* reach(signals, "Active")
	yield* printSnapshot("Feed available")
	yield* venue.quote({ at: 0, price: 60_000 })
	yield* venue.quote({ at: 30_000, price: 60_900 })
	yield* venue.quote({ at: 60_000, price: 60_800 })
	yield* waitForLog(
		"alerts: BTC-USD minute 0: rose at least 1% (60000 -> 60900)",
	)
	yield* waitForLog("candles: accepted quote at 60000")

	yield* Effect.log(
		"--- 3. Drop the socket. Watch alerts stop before candles, then the connection closes ---",
	)
	yield* venue.disconnect(
		Cause.fail(
			ExchangeUnavailable.make({
				operation: "read",
				detail: "Venue closed the WebSocket",
			}),
		),
	)
	yield* reach(feed, "Failed")
	yield* reach(bars, "Pending")
	yield* reach(signals, "Pending")
	yield* printSnapshot("Services withdrawn; Graft will retry after 400 ms")
	yield* waitForLog("exchange: connecting (attempt 2)")
	yield* reach(feed, "Failed")
	yield* printSnapshot("Connection refused; next retry after 800 ms")

	yield* reach(feed, "Active")
	yield* reach(bars, "Active")
	yield* reach(signals, "Active")
	yield* Effect.log(
		"--- 4. Recovered without restarting either consumer manually ---",
	)
	yield* printSnapshot("Feed recovered")
	yield* venue.quote({ at: 120_000, price: 61_000 })
	yield* venue.quote({ at: 150_000, price: 61_800 })
	yield* venue.quote({ at: 180_000, price: 61_700 })
	yield* waitForLog(
		"alerts: BTC-USD minute 2: rose at least 1% (61000 -> 61800)",
	)
	yield* waitForLog("candles: accepted quote at 180000")

	yield* Effect.log(
		"--- 5. Load the optional notifier. Only alerts restarts, now with webhook delivery ---",
	)
	const delivery = yield* Graft.plugin(notifier)
	yield* reach(delivery, "Active")
	yield* waitForLog("alerts: started (webhook)")
	yield* reach(signals, "Active")
	yield* venue.quote({ at: 210_000, price: 62_500 })
	yield* venue.quote({ at: 240_000, price: 62_400 })
	yield* waitForLog(
		"webhook: BTC-USD minute 3: rose at least 1% (61700 -> 62500)",
	)
	yield* waitForLog("candles: accepted quote at 240000")
	yield* printSnapshot("Optional delivery available")

	yield* Effect.log(
		"--- 6. Unload the notifier. Alerts returns to log-only delivery ---",
	)
	yield* delivery.dispose
	yield* waitForLog("alerts: started (log only)", 3)
	yield* reach(signals, "Active")
	yield* venue.quote({ at: 270_000, price: 63_100 })
	yield* venue.quote({ at: 300_000, price: 63_000 })
	yield* waitForLog(
		"alerts: BTC-USD minute 4: rose at least 1% (62400 -> 63100)",
	)
	yield* waitForLog("candles: accepted quote at 300000")
	yield* printSnapshot("Notifier removed; feed and candles stayed active")
	yield* Effect.log(
		"Done. Closing the scope also stops consumers before their providers.",
	)
})

const run = demo.pipe(
	Effect.scoped,
	// @effect-diagnostics-next-line strictEffectProvide:off -- this is the application entry point
	Effect.provide(
		Layer.provideMerge(Graft.layer, Logger.layer([Logger.consolePretty()])),
	),
)

NodeRuntime.runMain(run)
