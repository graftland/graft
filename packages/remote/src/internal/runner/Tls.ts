import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { Effect, Option, Redacted } from "effect"
import type { Duration } from "effect"
import type { Socket } from "effect/socket"
import { TLSSocket } from "node:tls"
import { PeerAuthenticationError } from "./model"
import { Peer } from "../../Auth"
import { identityFromSubjectAltName } from "../auth/mtls"

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

const authenticated = (authenticate: typeof identityFromSubjectAltName) =>
	Effect.gen(function* () {
		const socket = yield* Effect.serviceOption(NodeSocket.NetSocket)
		if (Option.isNone(socket))
			return yield* PeerAuthenticationError.make({
				detail: "An authenticated TLS client certificate is required",
			})
		const raw = socket.value
		// Own the socket before validation: a rejected SAN must close even without a reader.
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				raw.destroy()
			}),
		)
		// NetSocket is typed as net.Socket; this narrows it without a cast. TLS already authenticated the peer.
		if (!(raw instanceof TLSSocket))
			return yield* PeerAuthenticationError.make({
				detail: "An authenticated TLS client certificate is required",
			})
		return yield* authenticate(raw.getPeerCertificate().subjectaltname)
	})

export const listen = Effect.fnUntraced(function* (
	options: ListenOptions,
	authenticate = identityFromSubjectAltName,
) {
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
						const peer = yield* authenticated(authenticate)
						return yield* handler(socket).pipe(
							Effect.provideService(Peer, peer),
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
