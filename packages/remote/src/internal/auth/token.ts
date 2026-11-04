import { Effect, Option, Redacted } from "effect"
import { PeerAuthenticationError } from "../runner/model"

export const invalid = () =>
	PeerAuthenticationError.make({
		detail: "The bearer token is invalid",
		challenge: "invalid_token",
	})
export const read = (
	authorization: Option.Option<Redacted.Redacted<string>>,
): Effect.Effect<Redacted.Redacted<string>, PeerAuthenticationError> => {
	if (Option.isNone(authorization))
		return Effect.fail(
			PeerAuthenticationError.make({
				detail: "A bearer token is required",
				challenge: "missing",
			}),
		)
	const match = /^Bearer +([^ ]+)$/i.exec(Redacted.value(authorization.value))
	const token = match?.[1]
	return token === undefined
		? Effect.fail(invalid())
		: Effect.succeed(Redacted.make(token))
}
export const prepare = (token: Redacted.Redacted<string>) =>
	Effect.succeed(Redacted.make("Bearer " + Redacted.value(token)))
