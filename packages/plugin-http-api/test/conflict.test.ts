import { Array, Effect, Record, Schema, SubscriptionRef } from "effect"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSecurity,
	OpenApi,
} from "effect/http-api"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as HttpApis from "../src/HttpApis.ts"
import composer from "../src/index.ts"
import { capture, logs, request, run, start, waitFor } from "./utils.ts"

class Bearer extends HttpApiMiddleware.Service<Bearer>()(
	"@graftland/plugin-http-api/test/conflict.test/Bearer",
	{ security: { shared: HttpApiSecurity.bearer } },
) {}
class ApiKey extends HttpApiMiddleware.Service<ApiKey>()(
	"@graftland/plugin-http-api/test/conflict.test/ApiKey",
	{
		security: {
			shared: HttpApiSecurity.apiKey({ key: "x-key", in: "header" }),
		},
	},
) {}

for (const security of [false, true])
	it.live(
		`keeps both typed routes serving through a ${security ? "security scheme" : "operationId"} document conflict`,
		() =>
			Effect.gen(function* () {
				const { url } = yield* start
				const doc = yield* Graft.plugin(composer, {})
				yield* doc.await
				const document = yield* capture(HttpApis.Document)
				const authorization = yield* Graft.plugin(
					Plugin.make({
						name: "conflict-auth",
						apply: () =>
							Effect.gen(function* () {
								yield* Graft.provide(Bearer, { shared: (effect) => effect })
								yield* Graft.provide(ApiKey, { shared: (effect) => effect })
							}),
					}),
				)
				yield* authorization.await
				const endpoint = (path: "/left" | "/right") => {
					const base = HttpApiEndpoint.get("get", path, {
						success: Schema.String,
					})
					return security
						? base
						: base.annotate(OpenApi.Identifier, "same-operation")
				}
				const leftGroup = HttpApiGroup.make("left").add(endpoint("/left"))
				const rightGroup = HttpApiGroup.make("right").add(endpoint("/right"))
				const leftApi = HttpApi.make("left").add(
					security ? leftGroup.middleware(Bearer) : leftGroup,
				)
				const rightApi = HttpApi.make("right").add(
					security ? rightGroup.middleware(ApiKey) : rightGroup,
				)
				const left = yield* Graft.plugin(
					Plugin.make({
						name: "left",
						inject: [Bearer],
						apply: () =>
							HttpApis.serve(
								leftApi,
								["left"],
								HttpApiBuilder.group(leftApi, "left", (h) =>
									h.handle("get", () => Effect.succeed("left")),
								),
							),
					}),
				)
				yield* left.await
				yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/left"))
				const right = yield* Graft.plugin(
					Plugin.make({
						name: "right",
						inject: [ApiKey],
						apply: () =>
							HttpApis.serve(
								rightApi,
								["right"],
								HttpApiBuilder.group(rightApi, "right", (h) =>
									h.handle("get", () => Effect.succeed("right")),
								),
							),
					}),
				)
				yield* right.await
				yield* waitFor(document, ({ spec }) => !Record.has(spec.paths, "/left"))
				const l = yield* HttpApiClient.make(leftApi, { baseUrl: url })
				const r = yield* HttpApiClient.make(rightApi, { baseUrl: url })
				const leftValue = yield* l.left.get()
				const rightValue = yield* r.right.get()
				assert.strictEqual(leftValue, "left")
				assert.strictEqual(rightValue, "right")
				assert.isEmpty((yield* SubscriptionRef.get(document)).spec.paths)
				assert.notInclude(
					(yield* request(`${url}/openapi.json`)).text,
					'"/right"',
				)
				const entries = yield* logs
				const conflicts = Array.flatMap(entries, (entry) =>
					Array.filter(
						Array.ensure(entry.message),
						Schema.is(HttpApis.GroupConflict),
					),
				)
				assert.isNotEmpty(conflicts)
				assert.instanceOf(conflicts[0]?.cause, Error)
				yield* right.dispose
				yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/left"))
			}).pipe(run),
	)
