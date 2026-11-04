import { Array, Cause, Effect, String } from "effect"
import { AuthenticationFailed } from "../../Errors"

/** The dedicated CA supplies one graft URI and ordinary, unquoted SAN fields. */
export const identityFromSubjectAltName = (
	san: string | undefined,
): Effect.Effect<string, AuthenticationFailed> => {
	const uris = Array.filter(
		String.split(san ?? "", ", "),
		String.startsWith("URI:graft://"),
	)
	const [uri] = uris
	return uris.length === 1 && uri !== undefined
		? Effect.succeed(String.slice(4)(uri))
		: Effect.fail(
				AuthenticationFailed.make({
					reason: "invalid",
					cause: Cause.fail(
						"The peer certificate must contain exactly one graft SAN URI",
					),
				}),
			)
}
