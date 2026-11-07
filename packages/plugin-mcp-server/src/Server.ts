import { Context, type Effect, type Layer } from "effect"
import type { McpProtocol, McpSchema, McpServer } from "effect/ai"

import type { Graft } from "@graftland/graft"

/** Options for one transport; registrations are built in that transport's scope. */
export interface Options {
	readonly name: string
	readonly version: string
	readonly description?: string | undefined
	readonly websiteUrl?: string | undefined
	readonly icons?: ReadonlyArray<McpSchema.Icon> | undefined
	readonly instructions?: string | undefined
	readonly protocols: readonly [
		McpProtocol.ProtocolAdapter,
		...Array<McpProtocol.ProtocolAdapter>,
	]
	readonly cacheHints?: McpServer.CacheHints | undefined
	readonly extensions?: Record<string, unknown> | undefined
	readonly registrations: Layer.Layer<
		never,
		never,
		McpServer.McpServer | Graft.Graft
	>
}
export class Server extends Context.Service<
	Server,
	{
		readonly options: Effect.Effect<Options>
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- the approved realm key includes its module and token name
>()("@graftland/plugin-mcp-server/Server/Server") {}

/** Isolate these keys together at the group containing the core, transports and contributors. */
export const isolate = [
	"@graftland/plugin-mcp-server/Server/Server",
	"@graftland/plugin-mcp-server/Catalog/Offered",
	"@graftland/plugin-mcp-server/Catalog/Changed",
	"@graftland/plugin-mcp-server/Resources/Updated",
	"@graftland/plugin-mcp-server/Middleware/Middleware",
	"@graftland/plugin-mcp-server/Middleware/Visible",
	"@graftland/plugin-mcp-server/Extensions/Declared",
] as const
