import { Effect, Layer, Option, Stdio } from "effect"
import { McpServer } from "effect/ai"

import { Plugin } from "@graftland/graft"
import { ProcessStdio } from "@graftland/plugin-remote/ProcessStdio"

import { StdioConfig } from "./Config"
import { StdioUnavailable } from "./Errors"
import { Server } from "./Server"

export default Plugin.make({
	name: "@graftland/plugin-mcp-server/stdio",
	config: StdioConfig,
	// In a unit the kernel lends its process stdio; embedded, any Stdio serves.
	inject: [Server, Stdio.Stdio, Plugin.optional(ProcessStdio)],
	apply: Effect.fnUntraced(function* () {
		const lent = yield* Effect.serviceOption(ProcessStdio)
		// The server ends stdout once the client has closed stdin and every reply
		// is written; under graft start that ends the kernel's stdout and process.
		const stdio = Option.isSome(lent)
			? yield* lent.value.claim.pipe(
					Effect.catchTag("StdioDenied", () => StdioUnavailable.make({})),
				)
			: yield* Stdio.Stdio
		yield* Layer.build(
			McpServer.layerStdio({
				...(yield* (yield* Server).options),
			}).pipe(Layer.provide(Layer.succeed(Stdio.Stdio, stdio))),
		)
	}),
})
