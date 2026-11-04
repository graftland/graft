import { Option } from "effect"
import { Graft, Plugin } from "@graftland/graft"
import {
	Cause,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Path,
	Schema,
} from "effect"
import { Jwk, Jwks, Jwt } from "effect/jose"
import { Signature } from "effect/crypto"
import { HttpClient } from "effect/http"
import { JwtAuthenticator } from "../../Auth"
import { ConfigDirectory } from "@graftland/loader"
import { PeerAuthenticationError } from "../../internal/runner/model"
import * as Token from "../../internal/auth/token"

export const ClockTolerance = Schema.DurationFromString.check(
	Schema.makeFilter(
		(duration) =>
			Duration.isFinite(duration) && Duration.toMillis(duration) >= 0,
		{ expected: "a finite, non-negative duration" },
	),
)
export const Config = Schema.Struct({
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
const keys = Effect.fnUntraced(function* (config: typeof Config.Type) {
	if (config.keys.jwksUrl !== undefined)
		return Jwks.layerRemote({ url: config.keys.jwksUrl })
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* ConfigDirectory.pipe(
		Effect.map(Option.getOrElse(() => ".")),
	)
	const pem = yield* fs.readFileString(
		path.resolve(directory, config.keys.publicKey),
	)
	// A single PEM must support the allowed algorithms; use JWKS for multiple key types.
	const keys = yield* Effect.forEach(config.algorithms, (algorithm) =>
		Jwk.importSpki(pem, algorithm).pipe(Effect.flatMap(Jwk.exportPublic)),
	)
	return Jwks.layerLocal({ keys })
})
export default Plugin.make({
	name: "remote-jwt-authenticator",
	config: Config,
	inject: [
		FileSystem.FileSystem,
		Path.Path,
		Signature.Signature,
		HttpClient.HttpClient,
	],
	apply: Effect.fnUntraced(function* (config) {
		const keySet = yield* keys(config)
		const services = yield* Layer.build(keySet)
		const signature = yield* Signature.Signature
		yield* Graft.provide(JwtAuthenticator, {
			_tag: "Header",
			authenticate: (authorization) =>
				Token.read(authorization).pipe(
					Effect.flatMap((token) =>
						Jwt.verifyWithKeySet(
							Schema.Record(Schema.String, Schema.Unknown),
							token,
							{
								issuer: config.issuer,
								audience: config.audience,
								algorithms: config.algorithms,
								clockTolerance: config.clockTolerance,
								requiredClaims: ["exp"],
							},
						).pipe(
							Effect.flatMap((verified) =>
								Schema.decodeUnknownEffect(Schema.NonEmptyString)(
									verified.claims[config.identityClaim],
								),
							),
							Effect.mapError((error) =>
								PeerAuthenticationError.make({
									detail: "JWT authentication failed",
									challenge: "invalid_token",
									cause: Cause.fail(error),
								}),
							),
							Effect.provideService(Signature.Signature, signature),
							Effect.provideContext(services),
						),
					),
				),
		})
	}),
})
