import { Graft, Plugin } from "@graftland/graft"
import { Effect, Ref, Schema } from "effect"
import { Database } from "../Checkout.ts"
import { Ledger } from "../Orders.ts"

/**
 * Opens a connection pool and publishes it as `Database`. A query on a closed
 * pool is a defect: if Graft ever let one through, the sample would crash.
 */
export default Plugin.make({
	name: "database",
	config: Schema.Struct({ url: Schema.String }),
	inject: [Ledger],
	apply: Effect.fn("database.apply")(function* ({ url }) {
		const ledger = yield* Ledger
		const open = yield* Effect.acquireRelease(
			Effect.andThen(Effect.log(`Opened pool to ${url}`), Ref.make(true)),
			(open) =>
				Effect.andThen(
					Ref.set(open, false),
					Effect.log(`Closed pool to ${url}`),
				),
		)
		yield* Graft.provide(Database, {
			url,
			insert: Effect.fn("Database.insert")(function* (row) {
				if (!(yield* Ref.get(open)))
					return yield* Effect.die(
						new Error(`Query on the closed pool to ${url}`),
					)
				const receipt = { ...row, pool: url }
				yield* ledger.append(receipt)
				return receipt
			}),
		})
	}),
})
