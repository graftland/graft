import { Schema } from "effect"

export class StdioUnavailable extends Schema.TaggedError<
	StdioUnavailable,
	{ readonly brand: unique symbol }
>()("StdioUnavailable", {}) {
	override get message(): string {
		return "The MCP stdio transport needs stdout to itself: start it with graft start --stdio"
	}
}
