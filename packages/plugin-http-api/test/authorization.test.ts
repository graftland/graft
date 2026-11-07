import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpServer } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpApiEndpoint,
	HttpApiGroup,
} from "effect/http-api"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import {
	Authorization,
	Principal,
	TokenValidator,
} from "@graftland/plugin-http/Authorization"
import * as Http from "@graftland/plugin-http/Http"
import oauth from "@graftland/plugin-http/oauth"

import * as HttpApis from "../src/HttpApis.ts"
import { request, run, start } from "./utils.ts"

it.live(
	"applies the same resource guard to HttpApiBuilder layers and preserves the verified Principal",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const resource = url + "/private"
			const identity = {
				subject: "verified",
				issuer: "https://issuer.example",
				audience: [resource],
				scopes: ["read"],
			}
			yield* (yield* Graft.plugin(
				Plugin.make({
					name: "identity",
					apply: () =>
						Effect.gen(function* () {
							yield* Graft.provide(TokenValidator, {
								validate: () => Effect.succeed(identity),
							})
							yield* Graft.provide(Principal, {
								...identity,
								subject: "forged",
							})
						}),
				}),
			)).await
			yield* (yield* Graft.plugin(oauth, {
				resource,
				authorizationServers: [identity.issuer],
			})).await
			const api = HttpApi.make("private").add(
				HttpApiGroup.make("private").add(
					HttpApiEndpoint.get("get", "/private", { success: Schema.String }),
				),
			)
			const handlers = HttpApiBuilder.group(api, "private", (h) =>
				h.handle("get", () =>
					Effect.map(Principal, (principal) => principal.subject),
				),
			)
			yield* (yield* Graft.plugin(
				Plugin.make({
					name: "guarded-api",
					inject: [Authorization, Principal],
					apply: () =>
						Effect.gen(function* () {
							const authorization = yield* Authorization
							const guard = authorization.protect({
								path: "/private",
								scopes: ["read"],
							})
							const mounted = yield* Http.mount(
								HttpApiBuilder.layer(api).pipe(
									Layer.provide(handlers),
									Layer.provide(HttpServer.layerServices),
									Layer.provide(guard.layer),
								),
							)
							yield* HttpApis.advertise(
								[api.groups.private],
								Context.get(mounted, Http.Mounted),
							)
						}),
				}),
			)).await
			assert.strictEqual((yield* request(resource)).status, 401)
			const httpClient = yield* HttpClient.HttpClient
			const transport = HttpClient.mapRequest(
				httpClient,
				HttpClientRequest.bearerToken("opaque"),
			)
			const client = yield* HttpApiClient.make(api, { baseUrl: url }).pipe(
				Effect.provideService(HttpClient.HttpClient, transport),
			)
			const value = yield* client.private.get()
			assert.strictEqual(value, "verified")
		}).pipe(run),
)
