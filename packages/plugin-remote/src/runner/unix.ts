// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer takes a factory for an HTTP/1.1 server on the Unix socket
import { createServer } from "node:http"

import { Cause, Console, Effect, Option, Path, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { ConfigDirectory } from "@graftland/loader"

import { TransportError } from "../Errors"
import * as Server from "../internal/websocketServer"
import { Listener } from "../Transport"

export const Config = Schema.Struct({ path: Schema.String })
const Listening = Schema.fromJsonString(
	Schema.Struct({ event: Schema.Literal("Listening"), path: Schema.String }),
)
export default Plugin.make({
	name: "@graftland/plugin-remote/runner/unix",
	config: Config,
	inject: [Path.Path],
	apply: Effect.fnUntraced(function* (config) {
		const path = yield* Path.Path
		const directory = yield* ConfigDirectory
		const socket = path.resolve(
			Option.getOrElse(directory, () => "."),
			config.path,
		)
		yield* Graft.provide(Listener, {
			properties: {
				protocol: "unix",
				encrypted: false,
				network: false,
				carries: ["header"],
			},
			// Node rejects an occupied path and removes its own socket file when the server closes.
			bind: () =>
				Server.bind(createServer, { path: socket }).pipe(
					Effect.mapBoth({
						onSuccess: (server) => ({
							serve: server.serve,
							ready: server.ready.pipe(
								Effect.andThen(
									Schema.encodeEffect(Listening)({
										event: "Listening",
										path: socket,
									}).pipe(Effect.orDie, Effect.flatMap(Console.log)),
								),
							),
						}),
						onFailure: (error) =>
							TransportError.make({ cause: Cause.fail(error) }),
					}),
				),
		})
	}),
})
