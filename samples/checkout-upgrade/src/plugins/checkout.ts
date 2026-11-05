import { Graft, Plugin } from "@graftland/graft"
import { Effect } from "effect"
import { Checkout, Database, Pricing } from "../Checkout.ts"

/**
 * Quotes an order and stores the receipt. It is written as if `Database` and
 * `Pricing` never change: Graft restarts it whenever either one does.
 */
export default Plugin.make({
	name: "checkout",
	inject: [Database, Pricing],
	apply: Effect.fn("checkout.apply")(function* () {
		const database = yield* Database
		const pricing = yield* Pricing
		yield* Effect.acquireRelease(
			Effect.log(`Checkout up (pricing ${pricing.version}, ${database.url})`),
			() => Effect.log("Checkout down"),
		)
		yield* Graft.provide(Checkout, {
			place: (order) =>
				Effect.flatMap(pricing.quote(order), (total) =>
					database.insert({
						order: order.id,
						total,
						pricing: pricing.version,
					}),
				),
		})
	}),
})
