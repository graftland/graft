import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { Context, Effect, Option, Redacted, String } from "effect"
import type { Duration } from "effect"
import type { Socket } from "effect/socket"
import { TLSSocket } from "node:tls"
import { failure } from "./model"

export interface Credentials {
	readonly key: Redacted.Redacted<string>
	readonly cert: string
	readonly ca: string
}
export interface ListenOptions {
	readonly host: string
	readonly port: number
	readonly tls: Credentials
}
export interface ConnectOptions extends ListenOptions {
	readonly servername: string
	readonly openTimeout?: Duration.Input
}
/** Certificate fingerprints, not caller-supplied subjects, form the session namespace. */
export class Peer extends Context.Service<Peer, string>()(
	"@graftland/remote/internal/runner/Tls/Peer",
) {}

const authenticated = Effect.gen(function* () {
	const socket = yield* Effect.serviceOption(NodeSocket.NetSocket)
	if (
		Option.isNone(socket) ||
		!(socket.value instanceof TLSSocket) ||
		!socket.value.authorized
	)
		return yield* failure(
			"InvalidRequest",
			"An authenticated TLS client certificate is required",
		)
	const fingerprint = socket.value.getPeerCertificate().fingerprint256
	if (typeof fingerprint !== "string" || fingerprint.length === 0)
		return yield* failure(
			"InvalidRequest",
			"The peer certificate has no SHA-256 fingerprint",
		)
	return {
		identity: `sha256:${String.replaceAll(":", "")(String.toLowerCase(fingerprint))}`,
		socket: socket.value,
	}
})

export const listen = Effect.fnUntraced(function* (options: ListenOptions) {
	const server = yield* NodeSocketServer.makeTls({
		host: options.host,
		port: options.port,
		key: Redacted.value(options.tls.key),
		cert: options.tls.cert,
		ca: options.tls.ca,
		requestCert: true,
		rejectUnauthorized: true,
		minVersion: "TLSv1.3",
	})
	return {
		address: server.address,
		run: <A, E, R>(
			handler: (socket: Socket.Socket) => Effect.Effect<A, E, R>,
		) =>
			server.run((socket) =>
				Effect.scoped(
					Effect.gen(function* () {
						const peer = yield* authenticated
						// Closing a handler must not wait for an unresponsive peer to drain its socket.
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => {
								peer.socket.destroy()
							}),
						)
						return yield* handler(socket).pipe(
							Effect.provideService(Peer, peer.identity),
						)
					}),
				),
			),
	}
})

export const connect = (options: ConnectOptions) =>
	NodeSocket.makeTls({
		host: options.host,
		port: options.port,
		servername: options.servername,
		key: Redacted.value(options.tls.key),
		cert: options.tls.cert,
		ca: options.tls.ca,
		rejectUnauthorized: true,
		minVersion: "TLSv1.3",
		openTimeout: options.openTimeout ?? "10 seconds",
		chunkSize: 1,
	})
