import { NodeHttpServerRequest } from "@effect/platform-node"
import { HttpServerRequest } from "effect/http"
import { TLSSocket } from "node:tls"
import { Array, Effect, String } from "effect"
import { PeerAuthenticationError } from "../runner/model"

/** The dedicated CA supplies one graft URI and ordinary, unquoted SAN fields. */
export const identityFromSubjectAltName = (
	san: string | undefined,
): Effect.Effect<string, PeerAuthenticationError> => {
	const uris = Array.filter(
		String.split(san ?? "", ", "),
		String.startsWith("URI:graft://"),
	)
	const [uri] = uris
	return uris.length === 1 && uri !== undefined
		? Effect.succeed(String.slice(4)(uri))
		: Effect.fail(
				PeerAuthenticationError.make({
					detail: "The peer certificate must contain exactly one graft SAN URI",
				}),
			)
}

// Node verifies the certificate chain during the TLS handshake; only the SAN identifies the peer.
export const authenticate = (
	readIdentity: (
		san: string | undefined,
	) => Effect.Effect<string, PeerAuthenticationError>,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const { socket } = NodeHttpServerRequest.toIncomingMessage(request)
		if (!(socket instanceof TLSSocket))
			return yield* PeerAuthenticationError.make({
				detail: "Mutual TLS requires a secure WebSocket connection",
			})
		return yield* readIdentity(socket.getPeerCertificate().subjectaltname)
	})
