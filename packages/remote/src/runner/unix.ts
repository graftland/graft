import { Plugin } from "@graftland/graft"
import { Console, Effect, Path, Schema } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer takes a factory for a Node HTTP/1.1 server on the Unix socket
import { createServer } from "node:http"
import { NoAuthenticator } from "../Auth"
import { Supervisor } from "../Supervisor"
import { Directory } from "../internal/config"
import * as Server from "../internal/websocketServer"
import * as Channel from "../internal/socketChannel"

export const Config = Schema.Struct({
	path: Schema.String,
	auth: Schema.Literal(NoAuthenticator.key).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(NoAuthenticator.key)),
	),
})
export default Plugin.make({
	name: "remote-unix-listener",
	config: Config,
	inject: [Supervisor, NoAuthenticator, Path.Path],
	apply: Effect.fnUntraced(function* (config) {
		const supervisor = yield* Supervisor
		const auth = yield* NoAuthenticator
		const path = yield* Path.Path
		const directory = yield* Directory
		const socket = path.resolve(directory, config.path)
		// Node rejects an occupied path and removes its own socket file when the server closes.
		const listener = yield* Server.listen(
			createServer,
			{ path: socket },
			Effect.succeed(auth.identity),
		)
		yield* Plugin.fork(
			listener.run((socket) =>
				Channel.fromSocket(socket).pipe(Effect.flatMap(supervisor.accept)),
			),
		)
		const message = yield* Schema.encodeEffect(
			Schema.fromJsonString(
				Schema.Struct({
					event: Schema.Literal("Listening"),
					path: Schema.String,
				}),
			),
		)({ event: "Listening", path: socket })
		yield* Console.log(message)
	}),
})
