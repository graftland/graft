import { Effect, Option, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import type { LegacyAuthenticator } from "../../Auth"
import { authenticate as mtls } from "./mtls"

export const authenticate = (auth: LegacyAuthenticator, network: boolean) => {
	switch (auth._tag) {
		case "Mtls":
			return mtls(auth.authenticate)
		case "None":
			return (
				network
					? Effect.logWarning(
							"Remote WebSocket connection has no authentication",
						)
					: Effect.void
			).pipe(Effect.as(auth.identity))
		case "Header":
			return HttpServerRequest.HttpServerRequest.pipe(
				Effect.flatMap((request) =>
					auth.authenticate(
						Option.map(
							Option.fromUndefinedOr(request.headers["authorization"]),
							Redacted.make,
						),
					),
				),
			)
	}
}
export const warn = (auth: LegacyAuthenticator, insecure: boolean) =>
	Effect.all(
		[
			insecure
				? Effect.logWarning(
						auth._tag === "Header"
							? "Remote ws:// listener is unencrypted; credentials are transmitted in plaintext"
							: "Remote ws:// listener is unencrypted",
					)
				: Effect.void,
			auth._tag === "None"
				? Effect.logWarning("Remote WebSocket listener has no authentication")
				: Effect.void,
		],
		{ discard: true },
	)
