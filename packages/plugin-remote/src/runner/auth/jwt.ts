import { Cause, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Signature } from "effect/crypto"
import { HttpClient } from "effect/http"
import { Jwk, Jwks, Jwt } from "effect/jose"

import { Graft, Plugin } from "@graftland/graft"
import { ConfigDirectory } from "@graftland/loader"

import { Authenticator } from "../../Auth"
import { AuthenticationFailed, AuthenticatorUnavailable } from "../../Errors"
import { Jwt as Config } from "../../internal/auth/config"
import * as Token from "../../internal/auth/token"

export { ClockTolerance } from "../../internal/auth/config"

export { Config }
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
		yield* Graft.provide(Authenticator, {
			_tag: "Header",
			issuer: config.issuer,
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
							// An unreachable key set says nothing about the token; the client must not discard it.
							Effect.mapError((error) =>
								error._tag === "JoseError" &&
								error.reason._tag === "KeySetUnavailable"
									? AuthenticatorUnavailable.make({ cause: Cause.fail(error) })
									: AuthenticationFailed.make({
											reason: "invalid",
											challenge: 'Bearer error="invalid_token"',
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
