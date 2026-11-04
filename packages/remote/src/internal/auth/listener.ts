import { Plugin, type Fork, type Graft } from "@graftland/graft"
import { Effect, Option, Redacted, Stream, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import type { Authenticator } from "../../Auth"
import { authenticate as mtls } from "./mtls"

export const follow = Effect.fnUntraced(function* <E>(
	fork: Fork.Fork<void, E>,
): Effect.fn.Return<
	void,
	E | Schema.SchemaError,
	Graft.Graft | Plugin.Tasks<E | Schema.SchemaError>
> {
	yield* fork.await
	yield* Plugin.fork(
		fork.state.pipe(
			Stream.runForEach((state) =>
				state._tag === "Failed" ? Effect.failCause(state.cause) : Effect.void,
			),
		),
	)
})
export const authenticate = (auth: Authenticator, network: boolean) => {
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
export const warn = (auth: Authenticator, insecure: boolean) =>
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
