import { Array, Effect, Option, Redacted, Schema, String } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { Graft, Plugin } from "@graftland/graft"

import {
	Authorization,
	AuthorizationConfigurationError,
	InsufficientScope,
	InvalidToken,
	Principal,
	ScopeToken,
	TokenValidator,
	Unauthorized,
} from "./Authorization"
import { OAuthConfig } from "./Config"
import * as Http from "./Http"

const Options = Schema.Struct({
	path: Schema.TemplateLiteral(["/", Schema.String]).check(
		Schema.isPattern(/^\/[^?#\\\s]*$/),
	),
	scopes: Schema.Array(ScopeToken),
})
/** Publish resource metadata and a guard backed by the injected validator. */
export default Plugin.make({
	name: "@graftland/plugin-http/oauth",
	config: OAuthConfig,
	inject: [TokenValidator],
	apply: Effect.fnUntraced(function* (config) {
		const validator = yield* TokenValidator
		const resource = yield* Schema.decodeEffect(Schema.URLFromString)(
			config.resource,
		)
		// RFC 9728 section 3.1 inserts the well-known suffix before the resource path.
		const metadataPath =
			`/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}` as const
		const metadataUrl = `${resource.origin}${metadataPath}${resource.search}`
		yield* Http.mount(
			HttpRouter.add(
				"GET",
				metadataPath,
				HttpServerResponse.jsonUnsafe({
					resource: config.resource,
					authorization_servers: config.authorizationServers,
					bearer_methods_supported: ["header"],
				}),
			),
		)
		yield* Graft.provide(Authorization, {
			protect: (input) =>
				HttpRouter.middleware<{ provides: Principal }>()(
					Effect.gen(function* () {
						const options = yield* Schema.decodeEffect(Options)(input).pipe(
							Effect.mapError((cause) =>
								AuthorizationConfigurationError.make({ cause }),
							),
						)
						const scope = Array.join(options.scopes, " ")
						const challenge = `Bearer resource_metadata="${metadataUrl}"${scope === "" ? "" : `, scope="${scope}"`}`
						return (effect) =>
							Effect.gen(function* () {
								const request = yield* HttpServerRequest.HttpServerRequest
								const path = String.split(request.url, "?")[0]!
								if (
									options.path !== "/" &&
									path !== options.path &&
									!String.startsWith(
										String.endsWith("/")(options.path)
											? options.path
											: `${options.path}/`,
									)(path)
								)
									return HttpServerResponse.empty({ status: 404 })
								const header = request.headers["authorization"]
								// RFC 6750 section 3.1: a request without bearer credentials,
								// including one using another scheme, gets no error code.
								if (header === undefined || !/^Bearer(?: |$)/i.test(header))
									return yield* Unauthorized.make({ challenge })
								const token = Option.fromNullishOr(
									/^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(header)?.[1],
								)
								if (Option.isNone(token))
									return yield* Unauthorized.make({
										challenge: `${challenge}, error="invalid_token"`,
										cause: InvalidToken.make({
											cause: "Malformed bearer credentials",
										}),
									})
								const principal = yield* validator
									.validate(Redacted.make(token.value))
									.pipe(
										Effect.mapError((error) =>
											error._tag === "InvalidToken"
												? Unauthorized.make({
														challenge: `${challenge}, error="invalid_token"`,
														cause: error,
													})
												: error,
										),
									)
								// RFC 9728 section 7.4: a token must target this protected resource.
								if (!Array.contains(principal.audience, config.resource))
									return yield* Unauthorized.make({
										challenge: `${challenge}, error="invalid_token"`,
										cause: InvalidToken.make({
											cause: "Token audience does not include this resource",
										}),
									})
								if (
									!Array.every(options.scopes, (required) =>
										Array.contains(principal.scopes, required),
									)
								)
									return yield* InsufficientScope.make({
										challenge: `${challenge}, error="insufficient_scope"`,
										scopes: options.scopes,
										cause: "The token does not grant every required scope",
									})
								return yield* Effect.provideService(
									effect,
									Principal,
									principal,
								)
							})
					}),
				),
		})
	}),
})
