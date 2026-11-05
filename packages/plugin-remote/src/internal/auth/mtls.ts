import { Array, Cause, Effect, Schema, String } from "effect"
import { AuthenticationFailed } from "../../Errors"

// Node JSON-quotes SAN values containing separators, escaping commas inside the value.
const uriValue = (field: string) => {
	const value = String.slice(4)(field)
	return String.startsWith('"')(value)
		? Schema.decodeEffect(Schema.fromJsonString(Schema.String))(value).pipe(
				Effect.mapError((error) =>
					AuthenticationFailed.make({
						reason: "invalid",
						cause: Cause.fail(error),
					}),
				),
			)
		: Effect.succeed(value)
}

/** Read exactly one graft URI from Node's plain or JSON-quoted SAN representation. */
export const identityFromSubjectAltName = Effect.fnUntraced(function* (
	san: string | undefined,
): Effect.fn.Return<string, AuthenticationFailed> {
	const values = yield* Effect.forEach(
		Array.filter(String.split(san ?? "", ", "), String.startsWith("URI:")),
		uriValue,
	)
	const uris = Array.filter(values, String.startsWith("graft://"))
	const [uri] = uris
	return yield* uris.length === 1 && uri !== undefined
		? Effect.succeed(uri)
		: Effect.fail(
				AuthenticationFailed.make({
					reason: "invalid",
					cause: Cause.fail(
						"The peer certificate must contain exactly one graft SAN URI",
					),
				}),
			)
})
