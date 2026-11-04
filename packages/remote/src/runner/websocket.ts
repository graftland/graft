import { Plugin } from "@graftland/graft"
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { MtlsAuthenticator } from "../Auth"
import { Supervisor } from "../Supervisor"
import { Directory } from "../internal/config"
import { createSecureServer } from "node:http2"
import * as WebsocketServer from "../internal/websocketServer"
import { Url, path as upgradePath } from "../internal/websocket"
import { authenticate } from "../internal/auth/mtls"
import * as Channel from "../internal/socketChannel"

export const Config = Schema.Struct({
	url: Url.check(
		Schema.makeFilter(
			(url) => url.pathname === "/" || url.pathname === upgradePath,
			{
				expected: "a listener URL with no path or /graft",
			},
		),
	),
	cert: Schema.String,
	key: Schema.String,
	// The listener injects the authenticator selected by its configuration.
	auth: Schema.Literal(MtlsAuthenticator.key),
})

export default Plugin.make({
	name: "remote-websocket-listener",
	config: Config,
	inject: [Supervisor, MtlsAuthenticator, FileSystem.FileSystem, Path.Path],
	apply: Effect.fnUntraced(function* (config) {
		const supervisor = yield* Supervisor
		const auth = yield* MtlsAuthenticator
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = yield* Directory
		const key = yield* fs.readFileString(path.resolve(directory, config.key))
		const cert = yield* fs.readFileString(path.resolve(directory, config.cert))
		const listener = yield* WebsocketServer.listen(
			() =>
				createSecureServer({
					allowHTTP1: true,
					ca: auth.ca,
					cert,
					key,
					minVersion: "TLSv1.3",
					requestCert: true,
					rejectUnauthorized: true,
				}),
			{ host: config.url.hostname, port: Number(config.url.port || 443) },
			authenticate(auth.authenticate),
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
					port: Schema.NullOr(Schema.Int),
				}),
			),
		)({
			event: "Listening",
			port:
				listener.address._tag === "UnixPathAddress"
					? null
					: listener.address.port,
		})
		yield* Console.log(message)
	}),
})
