import {
	Array,
	Cause,
	Effect,
	Equal,
	Exit,
	Layer,
	Option,
	Stream,
	String,
	type Scope,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { alerts } from "../src/alerts.ts"
import { candles } from "../src/candles.ts"
import { exchange } from "../src/exchange.ts"
import { notifier } from "../src/notifier.ts"
import { hasMessage, reach, snapshot, waitForLog } from "../src/observe.ts"
import { makeScriptedExchange } from "../src/scripted-exchange.ts"
import {
	Candles,
	ExchangeTransport,
	ExchangeUnavailable,
	Quotes,
} from "../src/services.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

const readLogs = Effect.fn("readLogs")(function* (checkpoint: string) {
	yield* Effect.log(checkpoint)
	return yield* Graft.logs.pipe(
		Stream.takeUntil((entry) => hasMessage(entry, checkpoint)),
		Stream.runCollect,
	)
})

const messages = (logs: ReadonlyArray<Graft.LogEntry>) =>
	Array.flatMap(logs, (entry) =>
		Array.isArray(entry.message)
			? Array.filter(
					entry.message,
					(item): item is string => typeof item === "string",
				)
			: [],
	)
const count = (logs: ReadonlyArray<Graft.LogEntry>, message: string) =>
	Array.filter(logs, (entry) => hasMessage(entry, message)).length
const closedCandles = (logs: ReadonlyArray<Graft.LogEntry>) =>
	Array.map(
		Array.filter(logs, (entry) => hasMessage(entry, "candles: closed")),
		(entry) => (Array.isArray(entry.message) ? entry.message[1] : undefined),
	)

const setup = Effect.gen(function* () {
	const venue = yield* makeScriptedExchange
	yield* Graft.provide(ExchangeTransport, venue.transport)
	const bars = yield* Graft.plugin(candles)
	const signals = yield* Graft.plugin(alerts)
	yield* reach(bars, "Pending")
	yield* reach(signals, "Pending")
	return { venue, bars, signals }
})

const start = Effect.gen(function* () {
	const pipeline = yield* setup
	const feed = yield* Graft.plugin(exchange)
	yield* reach(feed, "Active")
	yield* reach(pipeline.bars, "Active")
	yield* reach(pipeline.signals, "Active")
	return { ...pipeline, feed }
})

const disconnected = ExchangeUnavailable.make({
	operation: "read",
	detail: "Venue closed the WebSocket",
})

describe("market feed", () => {
	it.effect(
		"waits for required services and aggregates minute OHLC candles with log-only alerts",
		() =>
			Effect.gen(function* () {
				const { venue, bars, signals } = yield* setup
				const waiting = yield* snapshot
				assert.deepStrictEqual(
					Array.map(waiting, (node) => [node.name, node.state]),
					[
						["candles", { _tag: "Pending", missing: [Quotes.key] }],
						["alerts", { _tag: "Pending", missing: [Candles.key] }],
					],
				)
				const before = yield* readLogs("Before exchange registration")
				assert.strictEqual(count(before, "candles: started"), 0)
				assert.strictEqual(count(before, "alerts: started (log only)"), 0)
				const feed = yield* Graft.plugin(exchange)
				yield* reach(feed, "Active")
				yield* reach(bars, "Active")
				yield* reach(signals, "Active")
				yield* venue.quote({ at: 0, price: 60_000 })
				yield* venue.quote({ at: 10_000, price: 61_200 })
				yield* venue.quote({ at: 20_000, price: 59_900 })
				yield* venue.quote({ at: 30_000, price: 60_600 })
				yield* venue.quote({ at: 60_000, price: 60_800 })
				yield* waitForLog(
					"alerts: BTC-USD minute 0: rose at least 1% (60000 -> 60600)",
				)
				yield* waitForLog("candles: accepted quote at 60000")
				yield* venue.quote({ at: 90_000, price: 60_700 })
				yield* venue.quote({ at: 180_000, price: 60_600 })
				yield* waitForLog("candles: accepted quote at 180000")
				yield* waitForLog("alerts: minute 1 stayed below the 1% threshold")
				const logs = yield* readLogs("Initial candles completed")
				assert.deepStrictEqual(closedCandles(logs), [
					{
						minute: 0,
						open: 60_000,
						high: 61_200,
						low: 59_900,
						close: 60_600,
						ticks: 4,
					},
					{
						minute: 1,
						open: 60_800,
						high: 60_800,
						low: 60_700,
						close: 60_700,
						ticks: 2,
					},
				])
				assert.strictEqual(
					count(
						logs,
						"alerts: BTC-USD minute 0: rose at least 1% (60000 -> 60600)",
					),
					1,
				)
				assert.isFalse(
					Array.some(messages(logs), (message) =>
						String.startsWith("webhook:")(message),
					),
				)
				assert.strictEqual(
					count(
						logs,
						"alerts: BTC-USD minute 1: rose at least 1% (60800 -> 60700)",
					),
					0,
				)
				const active = yield* snapshot
				assert.isTrue(
					Array.every(active, (node) => node.state._tag === "Active"),
				)
			}).pipe(run),
	)

	it.effect(
		"withdraws services on a supervised failure, retains the full cause, and retries after 400 then 800 ms",
		() =>
			Effect.gen(function* () {
				const { venue, bars, signals, feed } = yield* start
				const original = yield* snapshot
				yield* venue.quote({ at: 0, price: 60_000 })
				yield* waitForLog("candles: accepted quote at 0")
				const cause = Cause.combine(
					Cause.fail(disconnected),
					Cause.die("Frame decoder stopped with the socket"),
				)
				yield* venue.disconnect(cause)
				const failed = yield* reach(feed, "Failed")
				assert.strictEqual(failed._tag, "Failed")
				if (failed._tag === "Failed")
					assert.deepStrictEqual(
						Array.map(failed.cause.reasons, (reason) =>
							reason._tag === "Fail"
								? [reason._tag, reason.error]
								: reason._tag === "Die"
									? [reason._tag, reason.defect]
									: [reason._tag, reason.fiberId],
						),
						[
							["Fail", disconnected],
							["Die", "Frame decoder stopped with the socket"],
						],
					)
				const exit = yield* Effect.exit(feed.await)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit) && failed._tag === "Failed")
					assert.isTrue(Equal.equals(exit.cause, failed.cause))
				yield* reach(bars, "Pending")
				yield* reach(signals, "Pending")
				const withdrawnTree = yield* snapshot
				assert.deepStrictEqual(
					Array.map(withdrawnTree, (node) => [node.name, node.state._tag]),
					[
						["candles", "Pending"],
						["alerts", "Pending"],
						["exchange", "Failed"],
					],
				)
				const stopped = yield* readLogs("Failure cleanup completed")
				assert.deepStrictEqual(
					Array.filter(messages(stopped), (message) =>
						String.includes(": stopped")(message),
					),
					[
						"alerts: stopped (log only)",
						"candles: stopped; incomplete candle discarded",
						"exchange: stopped (connection 1)",
					],
				)
				const failureLog = Option.getOrThrow(
					Array.findFirst(stopped, (entry) =>
						hasMessage(entry, "The plugin's background task failed"),
					),
				)
				assert.strictEqual(failureLog.annotations["graft.fork"], feed.id)
				assert.strictEqual(failureLog.annotations["graft.plugin"], "exchange")
				if (failed._tag === "Failed")
					assert.isTrue(Equal.equals(failureLog.cause, failed.cause))

				const probe = yield* Graft.plugin(
					Plugin.make({
						name: "late consumer",
						inject: [Quotes, Candles],
						apply: () => Effect.void,
					}),
				)
				const missing = yield* reach(probe, "Pending")
				assert.deepStrictEqual(missing, {
					_tag: "Pending",
					missing: [Quotes.key, Candles.key],
				})
				yield* probe.dispose

				yield* TestClock.adjust("399 millis")
				const beforeFirstRetry = yield* venue.attempts
				assert.strictEqual(beforeFirstRetry, 1)
				yield* TestClock.adjust("1 millis")
				const afterFirstRetry = yield* venue.attempts
				assert.strictEqual(afterFirstRetry, 2)
				const refused = yield* reach(feed, "Failed")
				if (refused._tag === "Failed")
					assert.deepStrictEqual(
						Cause.findErrorOption(refused.cause),
						Option.some(
							ExchangeUnavailable.make({
								operation: "connect",
								detail: "Venue maintenance: connection refused",
							}),
						),
					)
				yield* TestClock.adjust("799 millis")
				const beforeSecondRetry = yield* venue.attempts
				assert.strictEqual(beforeSecondRetry, 2)
				yield* TestClock.adjust("1 millis")
				yield* reach(feed, "Active")
				yield* reach(bars, "Active")
				yield* reach(signals, "Active")
				const afterSecondRetry = yield* venue.attempts
				assert.strictEqual(afterSecondRetry, 3)
				const recovered = yield* snapshot
				assert.deepStrictEqual(
					Array.map(recovered, (node) => node.id),
					Array.map(original, (node) => node.id),
				)
				assert.isTrue(
					Array.every(recovered, (node) => node.state._tag === "Active"),
				)
				yield* venue.quote({ at: 10_000, price: 62_000 })
				yield* venue.quote({ at: 30_000, price: 62_800 })
				yield* venue.quote({ at: 60_000, price: 62_700 })
				yield* waitForLog(
					"alerts: BTC-USD minute 0: rose at least 1% (62000 -> 62800)",
				)
				yield* waitForLog("candles: accepted quote at 60000")
				const restored = yield* readLogs("Recovery completed")
				assert.deepStrictEqual(closedCandles(restored), [
					{
						minute: 0,
						open: 62_000,
						high: 62_800,
						low: 62_000,
						close: 62_800,
						ticks: 2,
					},
				])
				assert.strictEqual(count(restored, "candles: started"), 2)
				assert.strictEqual(count(restored, "alerts: started (log only)"), 2)
			}).pipe(run),
	)

	it.effect(
		"restarts only alerts when the optional notifier appears or disappears",
		() =>
			Effect.gen(function* () {
				const { venue, signals } = yield* start
				yield* venue.quote({ at: 0, price: 60_000 })
				yield* waitForLog("candles: accepted quote at 0")
				const delivery = yield* Graft.plugin(notifier)
				yield* reach(delivery, "Active")
				yield* waitForLog("alerts: started (webhook)")
				yield* reach(signals, "Active")
				yield* venue.quote({ at: 30_000, price: 60_900 })
				yield* venue.quote({ at: 60_000, price: 60_800 })
				yield* waitForLog(
					"webhook: BTC-USD minute 0: rose at least 1% (60000 -> 60900)",
				)
				yield* waitForLog("candles: accepted quote at 60000")
				yield* delivery.dispose
				yield* waitForLog("alerts: started (log only)", 2)
				yield* reach(signals, "Active")
				yield* venue.quote({ at: 90_000, price: 61_500 })
				yield* venue.quote({ at: 120_000, price: 61_400 })
				yield* waitForLog(
					"alerts: BTC-USD minute 1: rose at least 1% (60800 -> 61500)",
				)
				yield* waitForLog("candles: accepted quote at 120000")
				const logs = yield* readLogs("Optional delivery cycle completed")
				assert.strictEqual(count(logs, "exchange: started"), 1)
				assert.strictEqual(count(logs, "candles: started"), 1)
				assert.strictEqual(count(logs, "alerts: started (log only)"), 2)
				assert.strictEqual(count(logs, "alerts: started (webhook)"), 1)
				assert.strictEqual(count(logs, "alerts: stopped (log only)"), 1)
				assert.strictEqual(count(logs, "alerts: stopped (webhook)"), 1)
				assert.strictEqual(
					count(
						logs,
						"webhook: BTC-USD minute 0: rose at least 1% (60000 -> 60900)",
					),
					1,
				)
				assert.strictEqual(
					count(
						logs,
						"webhook: BTC-USD minute 1: rose at least 1% (60800 -> 61500)",
					),
					0,
				)
				assert.deepStrictEqual(
					Array.filter(
						messages(logs),
						(message) =>
							message === "alerts: stopped (webhook)" ||
							message === "notifier: stopped",
					),
					["alerts: stopped (webhook)", "notifier: stopped"],
				)
				assert.deepStrictEqual(closedCandles(logs), [
					{
						minute: 0,
						open: 60_000,
						high: 60_900,
						low: 60_000,
						close: 60_900,
						ticks: 2,
					},
					{
						minute: 1,
						open: 60_800,
						high: 61_500,
						low: 60_800,
						close: 61_500,
						ticks: 2,
					},
				])
				const connectionAttempts = yield* venue.attempts
				assert.strictEqual(connectionAttempts, 1)
			}).pipe(run),
	)

	it.effect(
		"disposes the feed in dependency order without retrying cancelled workers",
		() =>
			Effect.gen(function* () {
				const { venue, bars, signals, feed } = yield* start
				yield* feed.dispose
				yield* reach(feed, "Disposed")
				yield* reach(bars, "Pending")
				yield* reach(signals, "Pending")
				yield* TestClock.adjust("2 seconds")
				const logs = yield* readLogs("Disposal completed")
				assert.deepStrictEqual(
					Array.filter(messages(logs), (message) =>
						String.includes(": stopped")(message),
					),
					[
						"alerts: stopped (log only)",
						"candles: stopped; incomplete candle discarded",
						"exchange: stopped (connection 1)",
					],
				)
				assert.strictEqual(
					count(logs, "The plugin's background task failed"),
					0,
				)
				const connectionAttempts = yield* venue.attempts
				assert.strictEqual(connectionAttempts, 1)
				const remainingTree = yield* snapshot
				assert.deepStrictEqual(
					Array.map(remainingTree, (node) => [node.name, node.state._tag]),
					[
						["candles", "Pending"],
						["alerts", "Pending"],
					],
				)
			}).pipe(run),
	)
	it.effect("closes every plugin when the application scope exits", () =>
		Effect.gen(function* () {
			const { venue, bars, signals, feed } = yield* start.pipe(Effect.scoped)
			yield* reach(feed, "Disposed")
			yield* reach(bars, "Disposed")
			yield* reach(signals, "Disposed")
			yield* TestClock.adjust("2 seconds")
			const logs = yield* readLogs("Application scope closed")
			assert.deepStrictEqual(
				Array.filter(messages(logs), (message) =>
					String.includes(": stopped")(message),
				),
				[
					"alerts: stopped (log only)",
					"candles: stopped; incomplete candle discarded",
					"exchange: stopped (connection 1)",
				],
			)
			const tree = yield* snapshot
			assert.deepStrictEqual(tree, [])
			const attempts = yield* venue.attempts
			assert.strictEqual(attempts, 1)
			assert.strictEqual(count(logs, "The plugin's background task failed"), 0)
		}).pipe(run),
	)
})
