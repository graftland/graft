/**
 * The parts of the shop that outlive every plugin: the queue orders arrive on
 * and the database server's storage. They live in the environment, so
 * restarting plugins never loses an order or a row.
 */
import { Array, Context, Effect, Layer, Queue, Ref } from "effect"

export interface Order {
	readonly id: number
	readonly items: ReadonlyArray<{
		readonly sku: string
		readonly quantity: number
	}>
}

export interface Receipt {
	readonly order: number
	readonly total: number
	/** The pricing engine that quoted the order. */
	readonly pricing: string
	/** The connection pool that stored the receipt. */
	readonly pool: string
}

export class OrderQueue extends Context.Service<
	OrderQueue,
	Queue.Queue<Order>
>()("@graftland/sample-checkout-upgrade/Orders/OrderQueue") {
	static readonly layer = Layer.effect(OrderQueue)(Queue.unbounded<Order>())
}

/** Rows stored by the database server, whichever pool wrote them. */
export class Ledger extends Context.Service<
	Ledger,
	{
		readonly append: (receipt: Receipt) => Effect.Effect<void>
		readonly receipts: Effect.Effect<ReadonlyArray<Receipt>>
	}
>()("@graftland/sample-checkout-upgrade/Orders/Ledger") {
	static readonly layer = Layer.effect(Ledger)(
		Effect.map(Ref.make<ReadonlyArray<Receipt>>([]), (rows) => ({
			append: (receipt) => Ref.update(rows, Array.append(receipt)),
			receipts: Ref.get(rows),
		})),
	)
}
