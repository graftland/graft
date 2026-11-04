import { Array, Effect, Option, Schema } from "effect"
import { CliError, Flag } from "effect/cli"
import { Jwk } from "effect/jose"
import {
	BearerAuthenticator,
	JwtAuthenticator,
	MtlsAuthenticator,
	NoAuthenticator,
} from "../../Auth"
import { ClockTolerance } from "../../runner/auth/jwt"

export const flags = {
	auth: Flag.Literals("auth", ["none", "bearer", "jwt", "mtls"]).pipe(
		Flag.optional,
	),
	identity: Flag.String("identity").pipe(Flag.optional),
	ca: Flag.String("ca").pipe(Flag.optional),
	tokens: Flag.String("tokens").pipe(Flag.optional),
	jwtIssuer: Flag.String("jwt-issuer").pipe(Flag.optional),
	jwtAudience: Flag.String("jwt-audience").pipe(Flag.atLeast(0)),
	jwtAlgorithm: Flag.Literals(
		"jwt-algorithm",
		Jwk.AsymmetricAlgorithm.literals,
	).pipe(Flag.atLeast(0)),
	jwtJwks: Flag.String("jwt-jwks").pipe(Flag.optional),
	jwtPublicKey: Flag.String("jwt-public-key").pipe(Flag.optional),
	jwtIdentityClaim: Flag.String("jwt-identity-claim").pipe(Flag.optional),
	jwtClockTolerance: Flag.String("jwt-clock-tolerance").pipe(
		Flag.withSchema(ClockTolerance),
		Flag.optional,
	),
}
type Options = {
	readonly [K in keyof typeof flags]: (typeof flags)[K] extends Flag.Flag<
		infer A
	>
		? A
		: never
}
export const supplied = (
	options: Options,
): ReadonlyArray<readonly [string, boolean, string]> => [
	["identity", Option.isSome(options.identity), "none"],
	["ca", Option.isSome(options.ca), "mtls"],
	["tokens", Option.isSome(options.tokens), "bearer"],
	["jwt-issuer", Option.isSome(options.jwtIssuer), "jwt"],
	["jwt-audience", options.jwtAudience.length > 0, "jwt"],
	["jwt-algorithm", options.jwtAlgorithm.length > 0, "jwt"],
	["jwt-jwks", Option.isSome(options.jwtJwks), "jwt"],
	["jwt-public-key", Option.isSome(options.jwtPublicKey), "jwt"],
	["jwt-identity-claim", Option.isSome(options.jwtIdentityClaim), "jwt"],
	["jwt-clock-tolerance", Option.isSome(options.jwtClockTolerance), "jwt"],
]
export const usage = (message: string) =>
	CliError.UserError.make({ cause: message, userMessage: message })
export const required = <A>(value: Option.Option<A>, flag: string) =>
	Effect.fromOption(value, () => usage("--" + flag + " is required"))
const nonEmpty = <A>(values: ReadonlyArray<A>, flag: string) =>
	values.length > 0
		? Effect.succeed(values)
		: Effect.fail(usage("--" + flag + " is required"))
export const validate = (options: Options, stdio: boolean) =>
	Effect.forEach(
		supplied(options),
		([flag, present, mode]) =>
			present &&
			(mode !== Option.getOrElse(options.auth, () => "none") ||
				(stdio && flag !== "identity"))
				? Effect.fail(
						usage(
							"--" +
								flag +
								" does not apply to the selected authentication mode",
						),
					)
				: Effect.void,
		{ discard: true },
	)
export const anySupplied = (options: Options) =>
	Option.isSome(options.auth) ||
	Array.some(supplied(options), ([, present]) => present)

const jwt = Effect.fnUntraced(function* (options: Options) {
	if (Option.isSome(options.jwtJwks) === Option.isSome(options.jwtPublicKey))
		return yield* usage(
			"Specify exactly one of --jwt-jwks and --jwt-public-key",
		)
	const issuer = yield* required(options.jwtIssuer, "jwt-issuer")
	const audience = yield* nonEmpty(options.jwtAudience, "jwt-audience")
	const algorithms = yield* nonEmpty(options.jwtAlgorithm, "jwt-algorithm")
	const clockTolerance = yield* Option.match(options.jwtClockTolerance, {
		onNone: () => Effect.succeed({}),
		onSome: (duration) =>
			Schema.encodeEffect(ClockTolerance)(duration).pipe(
				Effect.map((clockTolerance) => ({ clockTolerance })),
			),
	})
	return {
		key: JwtAuthenticator.key,
		entry: {
			id: "remote-auth",
			name: "@graftland/plugin-remote/runner/auth/jwt",
			config: {
				issuer,
				audience,
				algorithms,
				...Option.match(options.jwtIdentityClaim, {
					onNone: () => ({}),
					onSome: (identityClaim) => ({ identityClaim }),
				}),
				...clockTolerance,
				keys: Option.isSome(options.jwtJwks)
					? { jwksUrl: options.jwtJwks.value }
					: {
							publicKey: yield* required(
								options.jwtPublicKey,
								"jwt-public-key",
							),
						},
			},
		},
	}
})
export const entry = Effect.fnUntraced(function* (options: Options) {
	switch (Option.getOrElse(options.auth, (): "none" => "none")) {
		case "jwt":
			return yield* jwt(options)
		case "bearer":
			return {
				key: BearerAuthenticator.key,
				entry: {
					id: "remote-auth",
					name: "@graftland/plugin-remote/runner/auth/bearer",
					config: { tokens: yield* required(options.tokens, "tokens") },
				},
			}
		case "mtls":
			return {
				key: MtlsAuthenticator.key,
				entry: {
					id: "remote-auth",
					name: "@graftland/plugin-remote/internal/legacy/runner/auth/mtls",
					config: { ca: yield* required(options.ca, "ca") },
				},
			}
		case "none":
			return {
				key: NoAuthenticator.key,
				entry: {
					id: "remote-auth",
					name: "@graftland/plugin-remote/internal/legacy/runner/auth/none",
					config: {
						identity: Option.getOrElse(options.identity, () => "anonymous"),
					},
				},
			}
	}
})
