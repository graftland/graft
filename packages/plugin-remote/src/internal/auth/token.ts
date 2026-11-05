import { Effect, Option, Redacted } from "effect"

import { AuthenticationFailed } from "../../Errors"

export const invalid = () =>
	AuthenticationFailed.make({
		reason: "invalid",
		challenge: 'Bearer error="invalid_token"',
	})
export const read = (
	authorization: Option.Option<Redacted.Redacted<string>>,
): Effect.Effect<Redacted.Redacted<string>, AuthenticationFailed> => {
	if (Option.isNone(authorization))
		return Effect.fail(
			AuthenticationFailed.make({
				reason: "missing",
				challenge: "Bearer",
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
