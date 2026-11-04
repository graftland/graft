import { Plugin } from "@graftland/graft"
import { Console, Effect, FileSystem, Path, Redacted, Schema } from "effect"
import { MtlsAuthenticator } from "../Auth"
import { Supervisor } from "../Supervisor"
import { Directory } from "../internal/config"
import * as Tls from "../internal/runner/Tls"
import * as Channel from "../internal/socketChannel"
import { connectionEnded } from "../internal/runner/connectionEnded"

export default Plugin.make({
	name: "remote-tls-listener",
	config: Schema.Struct({
		host: Schema.String,
		port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
		cert: Schema.String,
		key: Schema.String,
		// Stage 1 has one authenticator. Later transports select their own supported keys.
		auth: Schema.Literal(MtlsAuthenticator.key),
	}),
	inject: [Supervisor, MtlsAuthenticator, FileSystem.FileSystem, Path.Path],
	apply: Effect.fnUntraced(function* (config) {
		const supervisor = yield* Supervisor
		const auth = yield* MtlsAuthenticator
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = yield* Directory
		const key = yield* fs.readFileString(path.resolve(directory, config.key))
		const cert = yield* fs.readFileString(path.resolve(directory, config.cert))
		const listener = yield* Tls.listen(
			{
				host: config.host,
				port: config.port,
				tls: {
					ca: auth.ca,
					cert,
					key: Redacted.make(key),
				},
			},
			auth.authenticate,
		)
		yield* Plugin.fork(
			listener.run((socket) =>
				Channel.fromSocket(socket).pipe(
					Effect.flatMap(supervisor.accept),
					Effect.catchCause(connectionEnded),
				),
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
