import { Plugin } from "@graftland/graft"
import { Effect, Queue } from "effect"
import { Checkout } from "../Checkout.ts"
import { OrderQueue } from "../Orders.ts"

/**
 * Takes orders off the queue one at a time. An order it has taken is always
 * finished: stopping the worker waits for it, and only then does Graft
 * withdraw `Checkout` and everything behind it.
 */
export default Plugin.make({
	name: "order-worker",
	inject: [Checkout, OrderQueue],
	apply: () =>
		Effect.gen(function* () {
			const checkout = yield* Checkout
			const queue = yield* OrderQueue
			yield* Effect.acquireRelease(Effect.log("Order worker started"), () =>
				Effect.log("Order worker stopped"),
			)
			yield* Plugin.fork(
				Effect.forever(
					Effect.uninterruptibleMask((restore) =>
						restore(Queue.take(queue)).pipe(
							Effect.flatMap(checkout.place),
							Effect.flatMap((receipt) =>
								Effect.log(
									`Order #${receipt.order}: $${receipt.total} (pricing ${receipt.pricing}, ${receipt.pool})`,
								),
							),
						),
					),
				),
			)
		}),
})
