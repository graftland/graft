import { Array, Effect } from "effect"
import { McpProtocol } from "effect/ai"

import { Graft, Plugin } from "@graftland/graft"

import { Config } from "./Config"
import { snapshot } from "./internal/extensions"
import { projection } from "./internal/projection"
import { Server, type Options } from "./Server"

const adapters = {
	"2026-07-28": McpProtocol.v2026_07_28,
	"2025-11-25": McpProtocol.v2025_11_25,
	"2025-06-18": McpProtocol.v2025_06_18,
	"2025-03-26": McpProtocol.v2025_03_26,
	"2024-11-05": McpProtocol.v2024_11_05,
} as const

export default Plugin.make({
	name: "@graftland/plugin-mcp-server",
	config: Config,
	apply: Effect.fnUntraced(function* (config) {
		const context = yield* Effect.context<Graft.Graft>()
		const options: Effect.Effect<Options> = Effect.gen(function* () {
			const { values: extensions } = yield* snapshot
			const [first, ...rest] = config.protocols
			return {
				...config,
				protocols: [
					adapters[first],
					...Array.map(rest, (version) => adapters[version]),
				] as const,
				cacheHints: config.cache,
				extensions,
				registrations: projection(extensions),
			}
		}).pipe(Effect.provide(context))
		yield* Graft.provide(Server, { options })
	}),
})
