import { Array, Effect, Layer, Schema, String } from "effect"
import { SecureRandom, Signature } from "effect/crypto"
import { HttpClient } from "effect/http"
import { Jwks, Jwt } from "effect/jose"

import { Graft, Plugin } from "@graftland/graft"

import {
	InvalidToken,
	TokenValidator,
	ValidationUnavailable,
} from "../Authorization"
import { JwtConfig } from "../Config"

const Claims = Schema.Struct({
	sub: Schema.NonEmptyString,
	iss: Schema.String,
	aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
	exp: Schema.Finite,
	scope: Schema.optionalKey(Schema.String),
})
/** Validate signed access tokens with Effect's scoped remote JWKS cache. */
export default Plugin.make({
	name: "@graftland/plugin-http/oauth/jwt",
	config: JwtConfig,
	inject: [HttpClient.HttpClient],
	apply: Effect.fnUntraced(function* (config) {
		const keys = yield* Jwks.makeRemote({ url: config.jwksUrl })
		const crypto = yield* Layer.build(
			Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
		)
		yield* Graft.provide(TokenValidator, {
			validate: (token) =>
				Jwt.verifyWithKeySet(Claims, token, {
					issuer: config.issuer,
					audience: config.audience,
					algorithms: ["RS256", "PS256", "ES256", "EdDSA"],
					requiredClaims: ["exp", "iss", "aud", "sub"],
				}).pipe(
					Effect.mapBoth({
						onSuccess: ({ claims }) => ({
							subject: claims.sub,
							issuer: claims.iss,
							audience: Array.ensure(claims.aud),
							scopes:
								claims.scope === undefined
									? []
									: Array.filter(
											String.split(claims.scope, " "),
											(value) => value.length > 0,
										),
						}),
						onFailure: (error) =>
							error._tag === "JoseError" &&
							error.reason._tag === "KeySetUnavailable"
								? ValidationUnavailable.make({ cause: error })
								: InvalidToken.make({ cause: error }),
					}),
					Effect.provideService(Jwks.Jwks, keys),
					Effect.provideContext(crypto),
				),
		})
	}),
})
