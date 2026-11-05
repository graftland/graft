import { Duration, Effect, Schema } from "effect"
import { Jwk } from "effect/jose"

export const ClockTolerance = Schema.DurationFromString.check(
	Schema.makeFilter(
		(duration) =>
			Duration.isFinite(duration) && Duration.toMillis(duration) >= 0,
		{ expected: "a finite, non-negative duration" },
	),
)
export const Jwt = Schema.Struct({
	issuer: Schema.NonEmptyString,
	audience: Schema.NonEmptyArray(Schema.NonEmptyString),
	algorithms: Schema.NonEmptyArray(Jwk.AsymmetricAlgorithm),
	identityClaim: Schema.NonEmptyString.pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("sub")),
	),
	clockTolerance: ClockTolerance.pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("5 seconds")),
	),
	keys: Schema.Union([
		Schema.Struct({
			jwksUrl: Schema.String,
			publicKey: Schema.optionalKey(Schema.Never),
		}),
		Schema.Struct({
			publicKey: Schema.String,
			jwksUrl: Schema.optionalKey(Schema.Never),
		}),
	]),
})

export const Certificate = Schema.Struct({
	cert: Schema.String,
	key: Schema.String,
})
export const Token = Schema.Struct({
	token: Schema.Union([Schema.String, Schema.Struct({ file: Schema.String })]),
})
export const Mtls = Schema.Struct({ ca: Schema.String })
export const Bearer = Schema.Struct({ tokens: Schema.String })
export const None = Schema.Struct({
	identity: Schema.optionalKey(Schema.String),
})
