import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { Array, Cause, Context, Effect, Option, Redacted, String } from "effect"
import type { Duration } from "effect"
import type { Socket } from "effect/socket"
import { TLSSocket } from "node:tls"
import { InvalidSessionRequest } from "./model"

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
/** A dedicated CA attests the stable SAN URI used as the session namespace. */
export class Peer extends Context.Service<Peer, string>()(
	"@graftland/remote/internal/runner/Tls/Peer",
) {}

/**
 * Node quotes SAN values containing separators. Only top-level URI fields count;
 * a quoted DNS value containing ", URI:..." must never impersonate an identity.
 */
export const identityFromSubjectAltName = (san: string | undefined) =>
	Effect.gen(function* () {
		let fields: ReadonlyArray<string> = []
		let field = ""
		let quoted = false
		let escaped = false
		for (const character of san ?? "") {
			if (character === "," && !quoted) {
				fields = Array.append(fields, String.trim(field))
				field = ""
				continue
			}
			field += character
			if (escaped) escaped = false
			else if (character === "\\" && quoted) escaped = true
			else if (character === '"') quoted = !quoted
		}
		fields = Array.append(fields, String.trim(field))
		const uris = Array.filter(fields, (field) =>
			String.startsWith("URI:")(field),
		)
		if (
			quoted ||
			escaped ||
			uris.length !== 1 ||
			!/^URI:graft:\/\/[a-z0-9][a-z0-9._-]*$/.test(uris[0]!)
		)
			return yield* InvalidSessionRequest.make({
				detail:
					"The peer certificate must contain exactly one SAN URI of the form graft://name",
				cause: Cause.empty,
			})
		return String.slice(4)(uris[0]!)
	})

const authenticated = Effect.gen(function* () {
	const socket = yield* Effect.serviceOption(NodeSocket.NetSocket)
	if (Option.isNone(socket))
		return yield* InvalidSessionRequest.make({
			detail: "An authenticated TLS client certificate is required",
			cause: Cause.empty,
		})
	const raw = socket.value
	// Own the socket before validation: a rejected SAN must close even without a reader.
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			raw.destroy()
		}),
	)
	if (!(raw instanceof TLSSocket) || !raw.authorized)
		return yield* InvalidSessionRequest.make({
			detail: "An authenticated TLS client certificate is required",
			cause: Cause.empty,
		})
	return yield* identityFromSubjectAltName(
		raw.getPeerCertificate().subjectaltname,
	)
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
