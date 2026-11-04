import { Plugin, type Graft } from "@graftland/graft"
import { Cause, Effect } from "effect"
import { WebsocketTransport } from "../Transport"
import { TransportError } from "../Errors"
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

export default plugin
