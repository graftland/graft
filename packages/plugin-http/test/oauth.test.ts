import { Array, Clock, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { SecureRandom, Signature } from "effect/crypto"
import {
	HttpClient,
	HttpClientResponse,
	HttpRouter,
	HttpServerResponse,
} from "effect/http"
import { Jwk, Jwt } from "effect/jose"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import {
	Authorization,
	InvalidToken,
	Principal,
	TokenValidator,
	ValidationUnavailable,
} from "../src/Authorization.ts"
import * as Http from "../src/Http.ts"
import oauth from "../src/oauth.ts"
import jwt from "../src/oauth/jwt.ts"
import { capture, request, run, start } from "./utils.ts"

const crypto = Signature.layerWebCrypto.pipe(
	Layer.provide(SecureRandom.layerWebCrypto),
)
const issuer = "https://issuer.example"
const protectedMount = Plugin.make({
	name: "protected-mount",
	inject: [Authorization, Principal],
	apply: () =>
		Effect.gen(function* () {
			const authorization = yield* Authorization
			const guard = authorization.protect({
				path: "/mcp",
				scopes: ["tools:read"],
			})
			yield* Http.mount(
				Layer.unwrap(
					Effect.map(Effect.context<never>(), (context) =>
						HttpRouter.add(
							"GET",
							"/mcp",
							Effect.map(Principal, (principal) =>
								HttpServerResponse.text(principal.subject),
							).pipe(Effect.provideContext(context)),
						),
					),
				).pipe(Layer.provide(guard.layer)),
			)
		}),
})

it.live(
	"validates real JWTs, publishes metadata and lets request Principal override captured plugin services",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const resource = url + "/mcp"
			const pair = yield* Jwk.generateKeyPair({
				algorithm: "ES256",
				kid: "primary",
			})
			const key = yield* Jwk.importPrivate(pair.privateKey, "ES256")
			const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
			const claims = {
				iss: issuer,
				aud: resource,
				sub: "Alice",
				exp: now + 300,
				scope: "tools:read",
			}
			const keys = yield* Graft.plugin(
				Plugin.make({
					name: "jwks",
					apply: () =>
						Http.mount(
							HttpRouter.add(
								"GET",
								"/jwks",
								HttpServerResponse.jsonUnsafe({ keys: [pair.publicKey] }),
							),
						).pipe(Effect.asVoid),
				}),
			)
			yield* keys.await
			const client = yield* HttpClient.HttpClient
			const dependencies = yield* Graft.plugin(
				Plugin.make({
					name: "dependencies",
					apply: () =>
						Effect.gen(function* () {
							yield* Graft.provide(
								HttpClient.HttpClient,
								HttpClient.make((request) =>
									Effect.gen(function* () {
										const response = yield* client.get(url + "/jwks")
										const bytes = yield* response.arrayBuffer
										return HttpClientResponse.fromWeb(
											request,
											new Response(bytes, {
												status: response.status,
												headers: response.headers,
											}),
										)
									}),
								),
							)
							yield* Graft.provide(Principal, {
								subject: "forged-plugin-principal",
								issuer,
								audience: [resource],
								scopes: ["tools:read"],
							})
						}),
				}),
			)
			yield* dependencies.await
			const validator = yield* Graft.plugin(jwt, {
				issuer,
				audience: resource,
				jwksUrl: issuer + "/jwks",
			})
			yield* validator.await
			const authorization = yield* Graft.plugin(oauth, {
				resource,
				authorizationServers: [issuer],
			})
			yield* authorization.await
			const mount = yield* Graft.plugin(protectedMount)
			yield* mount.await
			const open = yield* Graft.plugin(
				Plugin.make({
					name: "guarded-subtree",
					inject: [Authorization],
					apply: () =>
						Effect.gen(function* () {
							const authorization = yield* Authorization
							const guard = authorization.protect({
								path: "/open/",
								scopes: [],
							})
							yield* Http.mount(
								HttpRouter.add(
									"GET",
									"/open/child",
									Effect.map(Principal, (principal) =>
										HttpServerResponse.text(principal.subject),
									),
								).pipe(Layer.provide(guard.layer)),
							)
						}),
				}),
			)
			yield* open.await
			const openChallenge = yield* request(url + "/open/child")
			assert.strictEqual(openChallenge.status, 401)
			assert.notInclude(openChallenge.headers["www-authenticate"]!, "scope=")

			const metadata = yield* request(
				url + "/.well-known/oauth-protected-resource/mcp",
			)
			assert.strictEqual(metadata.status, 200)
			const parsed = yield* Schema.decodeEffect(
				Schema.fromJsonString(
					Schema.Struct({
						resource: Schema.String,
						authorization_servers: Schema.Array(Schema.String),
					}),
				),
			)(metadata.text)
			assert.deepStrictEqual(parsed, {
				resource,
				authorization_servers: [issuer],
			})
			const challenge =
				'Bearer resource_metadata="' +
				url +
				'/.well-known/oauth-protected-resource/mcp", scope="tools:read"'
			const missing = yield* request(resource)
			assert.strictEqual(missing.status, 401)
			assert.strictEqual(missing.headers["www-authenticate"], challenge)
			const otherScheme = yield* request(resource, "GET", {
				authorization: "Basic secret",
			})
			assert.strictEqual(otherScheme.status, 401)
			assert.strictEqual(otherScheme.headers["www-authenticate"], challenge)
			const malformed = yield* request(resource, "GET", {
				authorization: "Bearer not a token",
			})
			assert.strictEqual(malformed.status, 401)
			assert.include(
				malformed.headers["www-authenticate"]!,
				'error="invalid_token"',
			)
			const good = yield* Jwt.sign(Schema.Json, claims, key)
			const accepted = yield* request(resource, "GET", {
				authorization: "Bearer " + Redacted.value(good),
			})
			assert.strictEqual(accepted.status, 200)
			assert.strictEqual(accepted.text, "Alice")
			const descendant = yield* request(url + "/open/child", "GET", {
				authorization: "Bearer " + Redacted.value(good),
			})
			assert.strictEqual(descendant.status, 200)
			assert.strictEqual(descendant.text, "Alice")

			for (const [patch, status, error] of [
				[{ scope: "other" }, 403, "insufficient_scope"],
				[{ aud: "https://other.example/mcp" }, 401, "invalid_token"],
				[{ iss: "https://other.example" }, 401, "invalid_token"],
				[{ exp: now - 60 }, 401, "invalid_token"],
			] as const) {
				const token = yield* Jwt.sign(Schema.Json, { ...claims, ...patch }, key)
				const response = yield* request(resource, "GET", {
					authorization: "Bearer " + Redacted.value(token),
				})
				assert.strictEqual(response.status, status)
				assert.include(
					response.headers["www-authenticate"]!,
					'error="' + error + '"',
				)
			}
			const other = yield* Jwk.generateKeyPair({
				algorithm: "ES256",
				kid: "primary",
			})
			const otherKey = yield* Jwk.importPrivate(other.privateKey, "ES256")
			const forged = yield* Jwt.sign(Schema.Json, claims, otherKey)
			assert.strictEqual(
				(yield* request(resource, "GET", {
					authorization: "Bearer " + Redacted.value(forged),
				})).status,
				401,
			)
			yield* keys.dispose
			yield* validator.update({
				issuer,
				audience: resource,
				jwksUrl: issuer + "/unavailable",
			})
			yield* validator.await
			yield* Stream.runHead(
				Stream.filter(mount.state, (state) => state._tag === "Active"),
			)
			const unavailable = yield* request(resource, "GET", {
				authorization: "Bearer " + Redacted.value(good),
			})
			assert.strictEqual(unavailable.status, 503)
			const unavailableValidator = yield* capture(TokenValidator)
			const unavailableCause = yield* Effect.flip(
				unavailableValidator.validate(good),
			)
			assert.isTrue(Schema.is(ValidationUnavailable)(unavailableCause))
			assert.isDefined(unavailableCause.cause)
			// A sibling validator can replace the first-party JWT plugin without changing the mount.
			const opaque = Plugin.make({
				name: "third-party-token-validator",
				apply: () =>
					Graft.provide(TokenValidator, {
						validate: (token) =>
							Redacted.value(token) === "down"
								? Effect.fail(
										ValidationUnavailable.make({
											cause: "Identity service unavailable",
										}),
									)
								: Array.contains(
											["opaque", "other-audience", "missing-scope"],
											Redacted.value(token),
									  )
									? Effect.succeed({
											subject: "Bob",
											issuer,
											audience:
												Redacted.value(token) === "other-audience"
													? ["https://other.example"]
													: [resource],
											scopes:
												Redacted.value(token) === "missing-scope"
													? []
													: ["tools:read"],
										})
									: Effect.fail(
											InvalidToken.make({ cause: "Unknown opaque token" }),
										),
					}),
			})
			yield* validator.dispose
			const replacement = yield* Graft.plugin(opaque)
			yield* replacement.await
			yield* Stream.runHead(
				Stream.filter(mount.state, (state) => state._tag === "Active"),
			)
			const replaced = yield* request(resource, "GET", {
				authorization: "Bearer opaque",
			})
			assert.strictEqual(replaced.status, 200)
			assert.strictEqual(replaced.text, "Bob")
			for (const [token, status] of [
				["other-audience", 401],
				["missing-scope", 403],
				["down", 503],
			] as const)
				assert.strictEqual(
					(yield* request(resource, "GET", {
						authorization: "Bearer " + token,
					})).status,
					status,
				)
			const service = yield* capture(TokenValidator)
			const failure = yield* Effect.flip(
				service.validate(Redacted.make("unknown")),
			)
			assert.strictEqual(failure.cause, "Unknown opaque token")
		}).pipe(Effect.provide(crypto), run),
)

it("uses deterministic authorization keys", () => {
	assert.deepStrictEqual(
		Array.map([Authorization, Principal, TokenValidator], (key) => key.key),
		[
			"@graftland/plugin-http/Authorization/Authorization",
			"@graftland/plugin-http/Authorization/Principal",
			"@graftland/plugin-http/Authorization/TokenValidator",
		],
	)
})
