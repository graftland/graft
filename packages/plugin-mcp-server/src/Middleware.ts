import type { Context } from "effect"
import type { McpSchema, McpServer } from "effect/ai"

import { Event } from "@graftland/graft"

export type Call = McpServer.MiddlewareOptions & {
	readonly services: Context.Context<never>
}
export const Middleware = Event.middleware<
	Call,
	McpServer.MiddlewareSuccess,
	McpSchema.McpErrorBase
>("@graftland/plugin-mcp-server/Middleware/Middleware")
export const Visible = Event.make<
	[call: Call],
	boolean,
	McpSchema.McpErrorBase
>("@graftland/plugin-mcp-server/Middleware/Visible")
