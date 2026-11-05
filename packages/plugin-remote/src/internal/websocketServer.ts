import { TLSSocket } from "node:tls"

import {
	Array,
	Cause,
	Deferred,
	Effect,
	Option,
	Redacted,
	Scope,
	String,
} from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Socket } from "effect/socket"
import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node"

import {
	TransportError,
	type AuthenticationFailed,
	type AuthenticatorUnavailable,
} from "../Errors"
import type { Accept, Handshake, Serving } from "../Transport"
import * as Channel from "./socketChannel"
import { path, payloadLimit, protocol } from "./websocket"

const rejection = (error: AuthenticationFailed | AuthenticatorUnavailable) =>
	error._tag === "AuthenticatorUnavailable"
		? unavailable(error)
		: unauthorized(error)

// The credential was not judged, so the client is told to retry rather than to replace it.
const unavailable = (error: AuthenticatorUnavailable) =>
	Effect.logError("Remote host authenticator is unavailable", error.cause).pipe(
		Effect.as(HttpServerResponse.empty({ status: 503 })),
	)

const unauthorized = (error: AuthenticationFailed) =>
	Effect.logWarning(
		"Remote host authentication failed",
		{
			reason: error.reason,
		},
		...(error.cause === undefined ? [] : [error.cause]),
	).pipe(
		Effect.as(
			HttpServerResponse.empty({
				status: 401,
				headers:
					error.challenge === undefined
						? {}
						: { "www-authenticate": error.challenge },
			}),
		),
	)

const handshake: Effect.Effect<
	Handshake,
	never,
	HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest
	const { socket } = NodeHttpServerRequest.toIncomingMessage(request)
	// Only a TLS-verified peer is certificate evidence; forwarded headers are not.
	const peer =
		socket instanceof TLSSocket && socket.authorized
			? Option.some(socket.getPeerCertificate())
			: Option.none()
	return {
		authorization: Option.map(
			Option.fromUndefinedOr(request.headers["authorization"]),
			Redacted.make,
		),
		certificate: Option.map(peer, (certificate) => ({
			der: certificate.raw,
			subjectAltName: Option.fromUndefinedOr(certificate.subjectaltname),
		})),
	}
})

const open = Effect.fnUntraced(function* (
	createServer: Parameters<typeof NodeHttpServer.make>[0],
	options: Pick<NodeHttpServer.Options, "host" | "port" | "path">,
) {
	// The lazily created ws server belongs here, so serving scopes close before ws.close waits.
	const resources = yield* Effect.acquireRelease(Scope.make(), Scope.close)
	const ready = yield* Deferred.make<void>()
	const server = yield* NodeHttpServer.make(createServer, {
		...options,
		disablePreemptiveShutdown: true,
		websocket: {
			perMessageDeflate: false,
			maxPayload: payloadLimit,
			handleProtocols: (protocols) =>
				protocols.has(protocol) ? protocol : false,
		},
	}).pipe(Scope.provide(resources))
	return {
		address: server.address,
		ready: Deferred.await(ready),
		run: <A, E, R>(
			accept: Effect.Effect<
				(socket: Socket.Socket) => Effect.Effect<A, E, R>,
				AuthenticationFailed | AuthenticatorUnavailable,
				HttpServerRequest.HttpServerRequest
			>,
		) =>
			server
				.serve(
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						if (request.url !== path)
							return HttpServerResponse.empty({ status: 404 })
						if (
							String.toLowerCase(request.headers["upgrade"] ?? "") !==
								"websocket" ||
							!Array.some(
								String.split(
									request.headers["sec-websocket-protocol"] ?? "",
									",",
								),
								(value) => String.trim(value) === protocol,
							)
						)
							return HttpServerResponse.empty({ status: 400 })
						const session = yield* Effect.result(accept)
						if (session._tag === "Failure")
							return yield* rejection(session.failure)
						// Authentication finishes before upgrade; session work is owned by the request scope.
						yield* request.upgrade.pipe(
							Effect.flatMap(session.success),
							Effect.interruptible,
							Effect.scoped,
						)
						return HttpServerResponse.empty()
					}),
				)
				.pipe(
					Effect.andThen(Deferred.succeed(ready, undefined)),
					Effect.andThen(Effect.never),
				),
	}
})

export const bind = Effect.fnUntraced(function* (
	createServer: Parameters<typeof NodeHttpServer.make>[0],
	options: Pick<NodeHttpServer.Options, "host" | "port" | "path">,
) {
	const server = yield* open(createServer, options)
	return {
		address: server.address,
		ready: server.ready,
		serve: (accept: Accept) =>
			server
				.run(
					handshake.pipe(
						Effect.flatMap(accept),
						Effect.map(
							(session) => (socket: Socket.Socket) =>
								Channel.fromSocket(socket).pipe(Effect.flatMap(session)),
						),
					),
				)
				.pipe(
					Effect.mapError((error) =>
						TransportError.make({ cause: Cause.fail(error) }),
					),
				),
	} satisfies Serving & { readonly address: typeof server.address }
})
