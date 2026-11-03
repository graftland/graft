/**
 * Orders keep arriving while the pricing engine is upgraded and the database
 * fails over to a new host. At the end, every order has exactly one receipt.
 *
 * Run it with `pnpm start` after building the workspace.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Graft } from "@graftland/graft"
import {
	Array,
	Effect,
	Fiber,
	HashSet,
	Layer,
	Logger,
	Queue,
	Schedule,
} from "effect"
import { Ledger, type Order, OrderQueue } from "./Orders.ts"
import checkout from "./plugins/checkout.ts"
import database from "./plugins/database.ts"
import { pricingV1, pricingV2 } from "./plugins/pricing.ts"
import worker from "./plugins/worker.ts"

const total = 24
const primary = "postgres://db-1.internal/shop"
const replacement = "postgres://db-2.internal/shop"

const carts: ReadonlyArray<Order["items"]> = [
	[{ sku: "mug", quantity: 1 }],
	[{ sku: "tee", quantity: 2 }],
	[
		{ sku: "poster", quantity: 2 },
		{ sku: "mug", quantity: 1 },
	],
]

/** A storefront placing an order every 25 ms. */
const storefront = Effect.gen(function* () {
	const queue = yield* OrderQueue
	yield* Effect.forEach(
		Array.range(1, total),
		(id) =>
			Effect.delay(
				Queue.offer(queue, { id, items: carts[id % carts.length] ?? [] }),
				"25 millis",
			),
		{ discard: true },
	)
})

const step = (title: string) => Effect.log(`--- ${title} ---`)

const program = Effect.gen(function* () {
	const ledger = yield* Ledger

	yield* step("1. Start the shop and let orders flow")
	const db = yield* Graft.plugin(database, { url: primary })
	yield* Graft.plugin(pricingV1)
	yield* Graft.plugin(checkout)
	yield* Graft.plugin(worker)
	const traffic = yield* Effect.forkScoped(storefront)
	yield* Effect.sleep("150 millis")

	yield* step("2. Upgrade pricing to v2 while orders keep arriving")
	yield* Graft.replace([[pricingV1, pricingV2]])
	yield* Effect.sleep("200 millis")

	yield* step("3. Fail over to a new database host")
	yield* db.update({ url: replacement })
	yield* Fiber.join(traffic)

	const receipts = yield* ledger.receipts.pipe(
		Effect.repeat({
			until: (receipts) => receipts.length === total,
			schedule: Schedule.spaced("20 millis"),
		}),
	)
	yield* step("4. Every order has exactly one receipt")
	const ids = HashSet.fromIterable(Array.map(receipts, (r) => r.order))
	const count = (f: (r: (typeof receipts)[number]) => boolean) =>
		Array.filter(receipts, f).length
	yield* Effect.log(
		`${total} orders placed, ${receipts.length} receipts, ${HashSet.size(ids)} distinct orders`,
	)
	yield* Effect.log(
		`Priced by v1: ${count((r) => r.pricing === "v1")}, by v2: ${count((r) => r.pricing === "v2")}`,
	)
	yield* Effect.log(
		`Stored through db-1: ${count((r) => r.pool === primary)}, through db-2: ${count((r) => r.pool === replacement)}`,
	)
})

program.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.provideMerge(
			Graft.layer,
			Layer.mergeAll(
				OrderQueue.layer,
				Ledger.layer,
				Logger.layer([Logger.consolePretty()]),
			),
		),
	),
	NodeRuntime.runMain,
)
