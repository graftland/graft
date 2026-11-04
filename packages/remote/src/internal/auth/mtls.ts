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
