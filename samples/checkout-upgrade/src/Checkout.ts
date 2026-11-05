import { Context, type Effect } from "effect"

import type { Order, Receipt } from "./Orders.ts"

/** A connection pool to the orders database. */
export class Database extends Context.Service<
	Database,
	{
		readonly url: string
		readonly insert: (receipt: Omit<Receipt, "pool">) => Effect.Effect<Receipt>
	}
>()("@graftland/sample-checkout-upgrade/Checkout/Database") {}

export class Pricing extends Context.Service<
	Pricing,
	{
		readonly version: string
		readonly quote: (order: Order) => Effect.Effect<number>
	}
>()("@graftland/sample-checkout-upgrade/Checkout/Pricing") {}

export class Checkout extends Context.Service<
	Checkout,
	{ readonly place: (order: Order) => Effect.Effect<Receipt> }
>()("@graftland/sample-checkout-upgrade/Checkout") {}
