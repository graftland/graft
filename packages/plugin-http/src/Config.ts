/** Configuration of the shared HTTP listener. */
import { Effect, Schema } from "effect"

/** The listener address. Use port zero for an OS-assigned port. */
export const Config = Schema.Struct({
	port: Schema.Union([
		Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
		// Check the encoded form too, so editor schemas reject invalid string ports.
		Schema.String.check(
			Schema.isPattern(
				/^0*(?:[0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])(?![\s\S])/u,
			),
		).pipe(
			Schema.decodeTo(
				Schema.FiniteFromString.check(
					Schema.isInt(),
					Schema.isBetween({ minimum: 0, maximum: 65535 }),
				),
			),
		),
	]).annotate({
		description: "TCP port. Required; zero selects an available port.",
	}),
	host: Schema.String.annotate({
		description: "Bind address. Defaults to 127.0.0.1.",
		default: "127.0.0.1",
	}).pipe(Schema.withDecodingDefaultKey(Effect.succeed("127.0.0.1"))),
})
export type Config = typeof Config.Type

/** Absolute resource identifiers without fragments or embedded credentials. */
const ResourceUrl = Schema.String.check(
	Schema.isPattern(/^https?:\/\/[^/?#@\s"\\]+(?:[/?][^\s#"\\]*)?$/u),
)
export const OAuthConfig = Schema.Struct({
	resource: ResourceUrl.annotate({
		description: "Public resource identifier and required token audience.",
	}),
	authorizationServers: Schema.NonEmptyArray(ResourceUrl).annotate({
		description: "Authorization server issuer identifiers.",
	}),
})
export const JwtConfig = Schema.Struct({
	issuer: ResourceUrl.annotate({
		description: "Expected access-token issuer.",
	}),
	audience: Schema.NonEmptyString.annotate({
		description: "Expected access-token audience.",
	}),
	jwksUrl: ResourceUrl.check(Schema.isPattern(/^https:\/\//u)).annotate({
		description: "Remote JSON Web Key Set URL.",
	}),
})
