import {
	Array,
	Effect,
	Layer,
	Option,
	Record,
	Schema,
	Stream,
	SubscriptionRef,
} from "effect"
import { FetchHttpClient, HttpRouter, HttpServerResponse } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpApiEndpoint,
	HttpApiGroup,
	OpenApi,
} from "effect/http-api"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import { Loader } from "@graftland/loader"
import * as Http from "@graftland/plugin-http/Http"

import { Config, UiConfig } from "../src/Config.ts"
import * as HttpApis from "../src/HttpApis.ts"
import composer from "../src/index.ts"
import { compose } from "../src/internal/compose.ts"
import scalar from "../src/scalar.ts"
import { entries } from "../src/schema.ts"
import swagger from "../src/swagger.ts"
import { fixture, moduleLayer } from "./module-fixtures"
import { capture, request, run, start, waitFor } from "./utils.ts"

it.effect(
	"decodes composer and UI defaults and registers all package names",
	() =>
		Effect.gen(function* () {
			const config = yield* Schema.decodeEffect(Config)({})
			assert.deepStrictEqual(config, {
				openapi: "/openapi.json",
			})
			const ui = yield* Schema.decodeEffect(UiConfig)({})
			assert.deepStrictEqual(ui, { path: "/docs" })
			assert.deepStrictEqual(
				Array.map(entries(), (entry) => entry.names),
				[
					["@graftland/plugin-http-api", "http-api"],
					["@graftland/plugin-http-api/scalar", "http-api/scalar"],
					["@graftland/plugin-http-api/swagger", "http-api/swagger"],
				],
			)
			for (const entry of entries())
				assert.strictEqual(entry.schema["additionalProperties"], false)
		}),
)

const api = HttpApi.make("entry").add(
	HttpApiGroup.make("entry").add(
		HttpApiEndpoint.get("get", "/entry", { success: Schema.String }),
	),
)
const entry = Plugin.make({
	name: "entry",
	apply: () =>
		HttpApis.serve(
			api,
			["entry"],
			HttpApiBuilder.group(api, "entry", (h) =>
				h.handle("get", () => Effect.succeed("loaded")),
			),
		),
})
it.live(
	"loads the short composer name alongside HTTP and groups through Loader.plugin",
	() =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(Loader.plugin, [
				{ id: "router", name: "http/router" },
				{ id: "http", name: "@graftland/plugin-http", config: { port: 0 } },
				{ id: "scalar", name: "http-api/scalar", config: { path: "/scalar" } },
				{
					id: "swagger",
					name: "http-api/swagger",
					config: { path: "/swagger" },
				},
				{ id: "api", name: "http-api", config: {} },
				{ id: "entry", name: "entry" },
			])
			yield* fork.await
			const loader = yield* capture(Loader.Loader)
			yield* loader.ready
			const { url } = yield* capture(Http.Server)
			const document = yield* capture(HttpApis.Document)
			yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/entry"))
			const client = yield* HttpApiClient.make(api, { baseUrl: url })
			const value = yield* client.entry.get()
			assert.strictEqual(value, "loaded")
			assert.include((yield* request(`${url}/openapi.json`)).text, "/entry")
			for (const path of ["/scalar", "/swagger"])
				assert.strictEqual((yield* request(url + path)).status, 200)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.provideMerge(
					Layer.fresh(Graft.layer),
					Layer.merge(
						FetchHttpClient.layer,
						moduleLayer({
							entry: fixture("entry-api"),
						}),
					),
				),
			),
		),
)

it.effect(
	"returns failure for a higher-order composition error with the original cause",
	() =>
		Effect.gen(function* () {
			const groups = Array.map(["a", "b", "c"], (name) =>
				HttpApiGroup.make(name).add(HttpApiEndpoint.get("get", `/${name}`)),
			)
			const cause = new Error("three-way failure")
			const info = OpenApi.annotations({
				transform: (spec) => {
					if (spec["tags"].length > 2) throw cause
					return spec
				},
			})
			const result = yield* Effect.flip(
				Effect.fromResult(compose(groups, info)),
			)
			assert.strictEqual(result.cause, cause)
		}),
)

it("uses deterministic public keys and plugin names", () => {
	assert.strictEqual(
		HttpApis.Groups.key,
		"@graftland/plugin-http-api/HttpApis/Groups",
	)
	assert.strictEqual(
		HttpApis.GroupsChanged.key,
		"@graftland/plugin-http-api/HttpApis/GroupsChanged",
	)
	assert.strictEqual(
		HttpApis.Document.key,
		"@graftland/plugin-http-api/HttpApis/Document",
	)
	assert.strictEqual(composer.name, "@graftland/plugin-http-api")
	assert.strictEqual(scalar.name, "@graftland/plugin-http-api/scalar")
	assert.strictEqual(swagger.name, "@graftland/plugin-http-api/swagger")
})

it.live(
	"accepts omitted composer and UI configuration and exposes editor defaults",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const fork = yield* Graft.plugin(composer, undefined)
			yield* fork.await
			yield* fork.stable
			assert.strictEqual((yield* request(`${url}/openapi.json`)).status, 200)
			assert.strictEqual((yield* request(`${url}/docs`)).status, 404)
			yield* fork.dispose
			const withoutUi = yield* Graft.plugin(composer, {})
			yield* withoutUi.await
			for (const plugin of [scalar, swagger]) {
				const view = yield* Graft.plugin(plugin, undefined)
				yield* view.await
				assert.strictEqual((yield* request(`${url}/docs`)).status, 200)
				yield* view.dispose
			}
			const serialized = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Unknown),
			)(entries())
			assert.include(serialized, '"default":"/openapi.json"')
			assert.include(serialized, '"default":"/docs"')
		}).pipe(run),
)

it.live(
	"updates a third-party document UI and changes a sibling UI path without restarting the composer",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const doc = yield* Graft.plugin(composer, {})
			yield* doc.await
			const document = yield* capture(HttpApis.Document)
			const view = yield* Graft.plugin(scalar, { path: "/reference" })
			yield* view.await
			const custom = yield* Graft.plugin(
				Plugin.make({
					name: "third-party-ui",
					inject: [HttpApis.Document],
					apply: () =>
						Effect.gen(function* () {
							const document = yield* HttpApis.Document
							yield* Http.mount(
								HttpRouter.add(
									"GET",
									"/custom",
									Effect.map(SubscriptionRef.get(document), ({ spec }) =>
										HttpServerResponse.html(
											Array.join(Record.keys(spec.paths), ","),
										),
									),
								),
							)
						}),
				}),
			)
			yield* custom.await
			const before = yield* Stream.runHead(Graft.forks)
			yield* view.update({ path: "/renamed" })
			yield* view.await
			const after = yield* Stream.runHead(Graft.forks)
			assert.deepStrictEqual(
				Array.findFirst(Option.getOrThrow(after), (node) => node.id === doc.id),
				Array.findFirst(
					Option.getOrThrow(before),
					(node) => node.id === doc.id,
				),
			)
			assert.strictEqual((yield* request(url + "/reference")).status, 404)
			assert.strictEqual((yield* request(url + "/renamed")).status, 200)
			yield* (yield* Graft.plugin(entry)).await
			yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/entry"))
			assert.include((yield* request(url + "/custom")).text, "/entry")
		}).pipe(run),
)

it("keeps composition internal to the composer", () =>
	assert.notProperty(HttpApis, "compose"))
