import { Plugin, type Graft } from "@graftland/graft"
import { Cause, Effect, Layer, Redacted } from "effect"
import { Socket } from "effect/socket"
import WS from "ws"
import type { PreparedCredentials } from "../Auth"
import { UnixTransport } from "../Transport"
import { TransportError } from "../Errors"
import { path, protocol, payloadLimit } from "../internal/websocket"
import * as Channel from "../internal/socketChannel"

const constructor = (credentials: PreparedCredentials) =>
	Layer.succeed(
		Socket.WebSocketConstructor,
		(url) =>
			new WS(url, protocol, {
				headers:
					credentials.authorization === undefined
						? {}
						: { authorization: Redacted.value(credentials.authorization) },
				perMessageDeflate: false,
				maxPayload: payloadLimit,
			}),
	)
const plugin: Plugin.Plugin<void, void, Graft.ServiceConflict> = Plugin.service(
	UnixTransport,
	Effect.succeed({
		connect: Effect.fnUntraced(
			function* (options, credentials = {}) {
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
	}),
	{ name: "remote-unix-transport" },
)
export default plugin
