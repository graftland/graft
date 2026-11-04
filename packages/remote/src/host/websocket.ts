import { Plugin, Graft } from "@graftland/graft"
import { Cause, Effect, FileSystem, Option, Path, Schema } from "effect"
import {
	Connector,
	WebsocketTransport,
	type ConnectorApi,
	type WebsocketOptions,
} from "../Transport"
import { TransportError } from "../Errors"
import { ConfigDirectory } from "@graftland/loader"
import * as Websocket from "../internal/websocket"
import * as Channel from "../internal/socketChannel"

const plugin: Plugin.Plugin<void, void, Graft.ServiceConflict> = Plugin.service(
	WebsocketTransport,
	Effect.succeed({
		connect: (options, certificate) =>
			Websocket.connect(options, certificate).pipe(
				Effect.flatMap(Channel.fromSocket),
				Effect.mapError((error) =>
					TransportError.make({ cause: Cause.fail(error) }),
				),
			),
	}),
	{ name: "remote-websocket-transport" },
)

export { plugin as legacy }

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
export const capability = Plugin.make({
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

export default capability
