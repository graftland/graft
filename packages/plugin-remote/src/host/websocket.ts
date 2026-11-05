import { Cause, Effect, FileSystem, Option, Path, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { ConfigDirectory } from "@graftland/loader"

import { TransportError } from "../Errors"
import * as Channel from "../internal/socketChannel"
import type { WebsocketOptions } from "../internal/transportOptions"
import * as Websocket from "../internal/websocket"
import { Connector, type ConnectorApi } from "../Transport"

/** Options for the websocket connector. */
export type { WebsocketOptions as Options } from "../internal/transportOptions"

/** Configured Connector; certificate paths belong to the enclosing configuration. */
export const Config = Schema.Struct({
	url: Websocket.Url,
	ca: Schema.optionalKey(Schema.String),
	servername: Schema.optionalKey(Schema.String),
})
export const make = (
	options: WebsocketOptions,
	properties: ConnectorApi["properties"],
): ConnectorApi => ({
	properties,
	connect: (prepared) =>
		Websocket.open(
			options,
			prepared._tag === "Certificate"
				? { certificate: prepared.value }
				: prepared._tag === "Authorization"
					? { authorization: prepared.value }
					: {},
		).pipe(
			Effect.flatMap(Channel.fromSocket),
			Effect.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
})
export default Plugin.make({
	name: "remote-websocket-connector",
	config: Config,
	inject: [FileSystem.FileSystem, Path.Path],
	apply: Effect.fnUntraced(function* (config) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = yield* ConfigDirectory.pipe(
			Effect.map(Option.getOrElse(() => ".")),
		)
		const ca =
			config.ca === undefined
				? undefined
				: yield* fs.readFileString(path.resolve(directory, config.ca))
		yield* Graft.provide(
			Connector,
			make(
				{
					url: config.url.href,
					tls: {
						...(ca === undefined ? {} : { ca }),
						...(config.servername === undefined
							? {}
							: { servername: config.servername }),
					},
				},
				Websocket.properties(config.url),
			),
		)
	}),
})
