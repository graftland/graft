import { Schema } from "effect"

export class StdioUnavailable extends Schema.TaggedError<
	StdioUnavailable,
	{ readonly brand: unique symbol }
>()("StdioUnavailable", {}) {
	override get message(): string {
		return "The MCP stdio transport needs the process stdio: start the kernel with graft start --stdio, and run only one stdio entry"
	}
}
