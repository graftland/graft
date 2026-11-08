import { Effect, Option, Stream } from "effect"

import * as Graft from "@graftland/graft/Graft"
import * as Plugin from "@graftland/graft/Plugin"

import { Config, Integration, Service } from "./shared.mjs"
import { connect } from "./socket.mjs"

const hold = (port) =>
	Effect.scoped(
		Effect.gen(function* () {
			const connection = yield* connect(port)
			yield* connection.write("held")
			const release = yield* Stream.runHead(connection.lines)
			if (Option.isNone(release))
				return yield* Effect.die("Gate closed without release")
		}),
	)
/** Static deployment data: every Change runs these probes before a version serves. */
export const deployment = { probes: ["health"] }

export const make = (version, healthy = true) =>
	Plugin.make({
		name: "integration",
		config: Config,
		overlap: true,
		provides: [Service],
		apply: (config) =>
			Effect.gen(function* () {
				const term = yield* Plugin.term
				yield* Plugin.probe(
					"health",
					healthy
						? Effect.void
						: Effect.fail("Version 3 is deliberately broken"),
				)
				yield* Graft.provide(Integration, {
					read: (city) =>
						Effect.gen(function* () {
							if (city === "held") yield* hold(config.gate)
							return { version, term }
						}),
				})
			}),
	})
