import { NodeHttpServer } from "@effect/platform-node"
import { Array, Effect, Scope, String } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Socket } from "effect/socket"
import { Peer } from "../Auth"
import type { PeerAuthenticationError } from "./runner/model"
import { connectionEnded } from "./runner/connectionEnded"
import { path, protocol, payloadLimit } from "./websocket"

/** Authentication and HTTP rejection finish before request.upgrade acquires a WebSocket. */
export const listen = Effect.fnUntraced(function* (
	createServer: Parameters<typeof NodeHttpServer.make>[0],
	options: Pick<NodeHttpServer.Options, "host" | "port" | "path">,
	authenticate: Effect.Effect<
		string,
		PeerAuthenticationError,
		HttpServerRequest.HttpServerRequest
	>,
) {
	// The lazily created ws server belongs here, so serving scopes close before ws.close waits.
	const resources = yield* Effect.acquireRelease(Scope.make(), Scope.close)
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
		run: <A, E, R>(handle: (socket: Socket.Socket) => Effect.Effect<A, E, R>) =>
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
						const identity = yield* authenticate
						yield* request.upgrade.pipe(
							// HTTP handlers start uninterruptible; connection work must stop with the listener.
							Effect.flatMap(handle),
							Effect.interruptible,
							Effect.catchCause(connectionEnded),
							Effect.provideService(Peer, identity),
						)
						return HttpServerResponse.empty()
					}).pipe(
						// Token decoding causes may contain credentials; report the rejection through HTTP and log only its reason.
						Effect.catchTag("PeerAuthenticationError", (error) =>
							Effect.logWarning("Remote host authentication failed", {
								reason: error.detail,
							}).pipe(
								Effect.as(
									HttpServerResponse.empty({
										status: 401,
										headers:
											error.challenge === undefined
												? {}
												: {
														"www-authenticate":
															error.challenge === "missing"
																? "Bearer"
																: 'Bearer error="invalid_token"',
													},
									}),
								),
							),
						),
					),
				)
				.pipe(Effect.andThen(Effect.never)),
	}
})
