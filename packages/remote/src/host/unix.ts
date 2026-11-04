/** Options for the unix connector. */
export type { UnixOptions as Options } from "../internal/transportOptions"
import type { UnixOptions } from "../internal/transportOptions"
import { Plugin, Graft } from "@graftland/graft"
import { ConfigDirectory } from "@graftland/loader"
import { Cause, Effect, Layer, Option, Path, Redacted, Schema } from "effect"
import { Socket } from "effect/socket"
import WS from "ws"
import type { Prepared } from "../Auth"
import { Connector, type ConnectorApi } from "../Transport"
import { TransportError } from "../Errors"
import { path, protocol, payloadLimit } from "../internal/websocket"
import * as Channel from "../internal/socketChannel"

export const properties: ConnectorApi["properties"] = {
	protocol: "unix",
	encrypted: false,
	network: false,
	carries: ["header"],
}
const constructor = (credentials: Prepared) =>
	Layer.succeed(
		Socket.WebSocketConstructor,
		(url) =>
			new WS(url, protocol, {
				headers:
					credentials._tag === "Authorization"
						? { authorization: Redacted.value(credentials.value) }
						: {},
				perMessageDeflate: false,
				maxPayload: payloadLimit,
			}),
	)
export const make = (options: UnixOptions): ConnectorApi => ({
	properties,
	connect: Effect.fnUntraced(
		function* (credentials) {
			const services = yield* Layer.build(constructor(credentials))
			const socket = yield* Socket.makeWebSocket(
				`ws+unix://${options.path}:${path}`,
			).pipe(Effect.provideContext(services))
			return yield* Channel.fromSocket(socket)
		},
		Effect.mapError((error) =>
			TransportError.make({ cause: Cause.fail(error) }),
		),
	),
})
export const Config = Schema.Struct({ path: Schema.String })
export default Plugin.make({
	name: "remote-unix-connector",
	config: Config,
	inject: [Path.Path],
	apply: Effect.fnUntraced(function* (config) {
		const path = yield* Path.Path
		const directory = yield* ConfigDirectory
		yield* Graft.provide(
			Connector,
			make({
				path: path.resolve(
					Option.getOrElse(directory, () => "."),
					config.path,
				),
			}),
		)
	}),
})
