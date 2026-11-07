import { Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Plan, Quota } from "./services.ts"

export const quota = Plugin.make({
	name: "@graftland/sample-saas-tenants/quota",
	apply: Effect.fn("quota.apply")(function* () {
		yield* Effect.log("Shared quota service started")
		yield* Graft.provide(Quota, {
			// Read at call time, in the tenant's request handler fiber.
			limit: Effect.gen(function* () {
				const plan = yield* Plan
				const limit = plan === "free" ? 1 : 3
				yield* Effect.log("Quota checked", { plan, limit })
				return limit
			}),
		})
	}),
})
