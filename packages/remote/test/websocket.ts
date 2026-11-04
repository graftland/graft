import { createSecureServer } from "node:http2"
import { Effect, Redacted } from "effect"
import type { Duration, Scope } from "effect"
import { Peer } from "../src/Auth"
import type { Channel as ByteChannel } from "../src/Transport"
import { make as mtls } from "../src/runner/auth/mtls"
import { accept } from "../src/internal/assembly"
import { properties } from "../src/internal/websocket"
import { connectionEnded } from "../src/internal/runner/connectionEnded"
import * as Websocket from "../src/internal/websocket"
import * as Server from "../src/internal/websocketServer"
import * as Channel from "../src/internal/socketChannel"
import * as Multiplex from "../src/internal/runner/Multiplex"

export interface Credentials {
	readonly ca: string
	readonly cert: string
	readonly key: Redacted.Redacted<string>
}
export const listen = (options: {
	readonly host: string
	readonly port: number
	readonly tls: Credentials
}) =>
	Server.bind(
		() =>
			createSecureServer({
				allowHTTP1: true,
				ca: options.tls.ca,
				cert: options.tls.cert,
				key: Redacted.value(options.tls.key),
				minVersion: "TLSv1.3",
				requestCert: true,
				rejectUnauthorized: true,
			}),
		options,
	).pipe(
		Effect.map((server) => ({
			address: server.address,
			run: <A, E>(
				handle: (
					channel: ByteChannel,
				) => Effect.Effect<A, E, Scope.Scope | Peer>,
			) =>
				server.serve(
					accept(
						mtls(options.tls.ca),
						properties(new URL("wss://localhost")),
						(identity) => (channel) =>
							handle(channel).pipe(
								Effect.catchCause(connectionEnded),
								Effect.provideService(Peer, identity),
							),
					),
				),
		})),
	)
export const connect = (options: {
	readonly port: number
	readonly tls: Credentials
	readonly servername: string
	readonly openTimeout?: Duration.Input
}) =>
	Websocket.open(
		{
			url: `wss://127.0.0.1:${options.port}`,
			tls: { ca: options.tls.ca, servername: options.servername },
			...(options.openTimeout === undefined
				? {}
				: { openTimeout: options.openTimeout }),
		},
		{ certificate: options.tls },
	)
export const multiplex = (
	socket: Parameters<typeof Channel.fromSocket>[0] | ByteChannel,
) =>
	"input" in socket
		? Multiplex.make(socket)
		: Channel.fromSocket(socket).pipe(Effect.flatMap(Multiplex.make))
