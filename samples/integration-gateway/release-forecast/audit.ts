import { Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { config } from "@example/forecast-contract"
import { Audit, service } from "@example/forecast-contract/audit"

export default Plugin.make({
	name: "@example/audit-release",
	config,
	provides: [service],
	overlap: true,
	apply: Effect.fnUntraced(function* (input) {
		yield* Plugin.probe(
			"health",
			input.unhealthy === true
				? Effect.fail("Audit probe failed")
				: Effect.void,
		)
		yield* Graft.provide(Audit, {
			record: Effect.succeed(input.prefix ?? "initial"),
		})
	}),
})
