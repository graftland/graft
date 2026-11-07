import { Deferred, Effect, Exit, Layer, Option, Sink, Stdio } from "effect"
import { McpServer } from "effect/ai"

import { Application, ProtocolOutput } from "@graftland/cli/Application"
import { Plugin } from "@graftland/graft"

import { StdioConfig } from "./Config"
import { StdioUnavailable } from "./Errors"
import { Server } from "./Server"

export default Plugin.make({
	name: "@graftland/plugin-mcp-server/stdio",
	config: StdioConfig,
	// Optional so that the server also runs outside the CLI, under any Stdio.
	inject: [Server, Stdio.Stdio, Plugin.optional(Application)],
	apply: Effect.fnUntraced(function* () {
		// Under graft start, stdout belongs to the protocol only with --stdio.
		const application = yield* Effect.serviceOption(Application)
		const stdio = yield* Stdio.Stdio
		// The server ends stdout once the client has closed stdin and every
		// reply is written; under graft start that ends the process too.
		const closed = yield* Deferred.make<void>()
		if (Option.isSome(application)) {
			if (!(yield* ProtocolOutput)) return yield* StdioUnavailable.make({})
			yield* application.value.claimProtocol
			yield* Plugin.fork(
				Deferred.await(closed).pipe(
					Effect.andThen(application.value.finish(Exit.void)),
				),
			)
		}
		const watched = Stdio.make({
			...stdio,
			stdout: (options) =>
				stdio
					.stdout(options)
					.pipe(
						Sink.onExit((exit) =>
							Exit.isSuccess(exit)
								? Deferred.succeed(closed, undefined)
								: Effect.void,
						),
					),
		})
		yield* Layer.build(
			McpServer.layerStdio({
				...(yield* (yield* Server).options),
			}).pipe(Layer.provide(Layer.succeed(Stdio.Stdio, watched))),
		)
	}),
})
