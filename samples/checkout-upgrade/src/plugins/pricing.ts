import { Array, Effect, Number, Option, Record } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Pricing } from "../Checkout.ts"
import type { Order } from "../Orders.ts"

const catalog: Record<string, number> = { mug: 12, poster: 20, tee: 25 }

const subtotal = (order: Order) =>
	Number.sumAll(
		Array.map(
			order.items,
			({ sku, quantity }) =>
				Option.getOrElse(Record.get(catalog, sku), () => 0) * quantity,
		),
	)

const engine = Effect.fn("pricing.engine")(function* (
	version: string,
	quote: (order: Order) => number,
) {
	yield* Effect.acquireRelease(Effect.log(`Pricing ${version} loaded`), () =>
		Effect.log(`Pricing ${version} unloaded`),
	)
	yield* Graft.provide(Pricing, {
		version,
		// Quoting takes a moment, like a call to a tax service would.
		quote: (order) => Effect.as(Effect.sleep("15 millis"), quote(order)),
	})
})

/** List prices. */
export const pricingV1 = Plugin.make({
	name: "@graftland/sample-checkout-upgrade/plugins/pricing/pricingV1",
	apply: () => engine("v1", subtotal),
})

/** List prices, with 10% off orders of three items or more. */
export const pricingV2 = Plugin.make({
	name: "@graftland/sample-checkout-upgrade/plugins/pricing/pricingV2",
	apply: () =>
		engine("v2", (order) => {
			const total = subtotal(order)
			const items = Number.sumAll(
				Array.map(order.items, (item) => item.quantity),
			)
			return items >= 3 ? Math.round(total * 90) / 100 : total
		}),
})
