import {
	Array,
	Effect,
	Layer,
	LogLevel,
	Option,
	Queue,
	Schedule,
	Stream,
	type Scope,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Ledger, OrderQueue, type Receipt } from "../src/Orders.ts"
import checkout from "../src/plugins/checkout.ts"
import database from "../src/plugins/database.ts"
import { pricingV1, pricingV2 } from "../src/plugins/pricing.ts"
import worker from "../src/plugins/worker.ts"

// Pricing really sleeps, like the tax call it stands for, so these tests run
// on the live clock. Their assertions do not depend on timing.
const run = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope | OrderQueue | Ledger>,
) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(
				Layer.fresh(Graft.layer),
				Layer.mergeAll(OrderQueue.layer, Ledger.layer),
			),
		),
	)

const text = (entry: Graft.LogEntry) =>
	Array.join(
		Array.map(Array.ensure(entry.message), (part) => `${part}`),
		" ",
	)

/** Every log entry written so far, oldest first. */
const logs = Effect.gen(function* () {
	yield* Effect.log("end of log")
	return yield* Stream.runCollect(
		Stream.takeUntil(Graft.logs, (entry) => text(entry) === "end of log"),
	)
})

/** Asserts that `expected` appear in `log` in this order, possibly with other lines between. */
const assertSequence = (
	log: ReadonlyArray<string>,
	expected: ReadonlyArray<string>,
) => {
	let from = 0
	for (const line of expected) {
		const index = log.indexOf(line, from)
		assert.isAtLeast(index, 0, `"${line}" missing after line ${from}`)
		from = index + 1
	}
}

const primary = "postgres://db-1.internal/shop"
const replacement = "postgres://db-2.internal/shop"

const start = Effect.gen(function* () {
	const db = yield* Graft.plugin(database, { url: primary })
	yield* Graft.plugin(pricingV1)
	yield* Graft.plugin(checkout)
	yield* Graft.plugin(worker)
	return db
})

/** Places orders `from` to `to`. */
const enqueue = (from: number, to: number) =>
	Effect.flatMap(OrderQueue, (queue) =>
		Queue.offerAll(
			queue,
			Array.map(Array.range(from, to), (id) => ({
				id,
				items: [{ sku: "tee", quantity: id % 4 }],
			})),
		),
	)

/** Waits until the stored receipts satisfy `done`. */
const receiptsUntil = (done: (receipts: ReadonlyArray<Receipt>) => boolean) =>
	Effect.flatMap(Ledger, (ledger) =>
		ledger.receipts.pipe(
			Effect.repeat({ until: done, schedule: Schedule.spaced("5 millis") }),
		),
	)

const receipts = (count: number) =>
	receiptsUntil((receipts) => receipts.length >= count)

describe("checkout-upgrade", () => {
	it.live("stops the consumers of the old engine before it unloads", () =>
		Effect.gen(function* () {
			yield* start
			yield* enqueue(1, 3)
			yield* receipts(3)
			yield* Graft.replace([[pricingV1, pricingV2]])
			// The old worker may still finish one of these with v1 before it stops.
			yield* enqueue(4, 8)
			yield* receiptsUntil(Array.some((r) => r.pricing === "v2"))

			const entries = yield* logs
			const log = Array.map(entries, text)
			assertSequence(log, [
				"Order worker stopped",
				"Checkout down",
				"Pricing v1 unloaded",
				"Pricing v2 loaded",
				`Checkout up (pricing v2, ${primary})`,
				"Order worker started",
			])
		}).pipe(run),
	)

	it.live("finishes an order in flight before closing the old pool", () =>
		Effect.gen(function* () {
			const db = yield* start
			yield* enqueue(1, 10)
			yield* receipts(2)
			yield* db.update({ url: replacement })
			const all = yield* receipts(10)

			const entries = yield* logs
			const log = Array.map(entries, text)
			// The last order stored through the old pool, possibly still in flight
			// when the update arrived, finishes before that pool closes.
			const last = Option.getOrThrow(
				Array.findLast(all, (r) => r.pool === primary),
			)
			assertSequence(log, [
				`Order #${last.order}: $${last.total} (pricing v1, ${primary})`,
				"Order worker stopped",
				"Checkout down",
				`Closed pool to ${primary}`,
				`Opened pool to ${replacement}`,
				"Order worker started",
			])
			// Receipts switch pools once and never go back.
			const pools = Array.dedupeAdjacent(Array.map(all, (r) => r.pool))
			assert.deepStrictEqual(pools, [primary, replacement])
		}).pipe(run),
	)

	it.live("gives every order exactly one receipt across both changes", () =>
		Effect.gen(function* () {
			const db = yield* start
			yield* enqueue(1, 30)
			yield* receipts(5)
			yield* Graft.replace([[pricingV1, pricingV2]])
			yield* receipts(12)
			yield* db.update({ url: replacement })
			const all = yield* receipts(30)

			assert.deepStrictEqual(
				Array.map(all, (r) => r.order),
				Array.range(1, 30),
			)
			const entries = yield* logs
			const errors = Array.filter(entries, (entry) =>
				LogLevel.isGreaterThanOrEqualTo(entry.level, "Error"),
			)
			assert.deepStrictEqual(Array.map(errors, text), [])
		}).pipe(run),
	)
})
