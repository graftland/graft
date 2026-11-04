import { Plugin } from "@graftland/graft"
import { Effect, Path, Schema } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer takes a factory for a Node HTTP/1.1 server on the Unix socket
import { createServer } from "node:http"
import { MtlsAuthenticator, NoAuthenticator } from "../Auth"
import { Directory } from "../internal/config"
import * as Listener from "../internal/listener"

export const Config = Schema.Struct({
	path: Schema.String,
	auth: Schema.String.check(
		Schema.makeFilter((key) => key !== MtlsAuthenticator.key, {
			expected: "header or none authentication for Unix sockets",
		}),
	).pipe(Schema.withDecodingDefaultKey(Effect.succeed(NoAuthenticator.key))),
})
const bind = Effect.fnUntraced(function* (config: typeof Config.Type) {
	const path = yield* Path.Path
	const directory = yield* Directory
	const socket = path.resolve(directory, config.path)
	// Node rejects an occupied path and removes its own socket file when the server closes.
	return {
		server: createServer,
		address: { path: socket },
		listening: () => ({ path: socket }),
	} satisfies Listener.Binding
})
export default Plugin.make({
	name: "remote-unix-listener",
	config: Config,
	apply: (config) =>
		Listener.start({
			auth: config.auth,
			protocol: "unix",
			inject: [Path.Path],
			bind: () => bind(config),
		}),
})
