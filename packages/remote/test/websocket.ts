import { createSecureServer } from "node:http2"
import { Effect, Redacted } from "effect"
import type { Duration } from "effect"
import {
	authenticate,
	identityFromSubjectAltName,
} from "../src/internal/auth/mtls"
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
	Server.listen(
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
		authenticate(identityFromSubjectAltName),
	)
export const connect = (options: {
	readonly port: number
	readonly tls: Credentials
	readonly servername: string
	readonly openTimeout?: Duration.Input
}) =>
	Websocket.connect(
		{
			url: `wss://127.0.0.1:${options.port}`,
			tls: { ca: options.tls.ca, servername: options.servername },
			...(options.openTimeout === undefined
				? {}
				: { openTimeout: options.openTimeout }),
		},
		{ certificate: options.tls },
	)
export const multiplex = (socket: Parameters<typeof Channel.fromSocket>[0]) =>
	Channel.fromSocket(socket).pipe(Effect.flatMap(Multiplex.make))
