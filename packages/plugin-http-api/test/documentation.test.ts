import {
	Array,
	ConfigProvider,
	Effect,
	FileSystem,
	Layer,
	Queue,
	Record,
	Schema,
	SubscriptionRef,
} from "effect"
import { FetchHttpClient } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpApiEndpoint,
	HttpApiGroup,
} from "effect/http-api"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Loader, ModuleResolver } from "@graftland/loader"
import server from "@graftland/plugin-http"
import * as Http from "@graftland/plugin-http/Http"
import router from "@graftland/plugin-http/router"

import { parse } from "yaml"

import * as HttpApis from "../src/HttpApis.ts"
import composer from "../src/index.ts"
import scalar from "../src/scalar.ts"
import { capture, request, waitFor } from "./utils.ts"

for (const page of ["http", "http-api"])
	it.live(
		`loads the ${page} YAML isolation example through Loader.plugin`,
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const text = yield* fs.readFileString(
					new URL(`../../docs/content/docs/${page}.md`, import.meta.url)
						.pathname,
				)
				const yaml = /```yaml\n([\s\S]*?)```/.exec(text)![1]!
				const decoded: unknown = parse(yaml, {
					customTags: [
						{ tag: "!env", resolve: (name: string) => new Entry.Env({ name }) },
					],
				})
				const original = yield* Schema.decodeUnknownEffect(Entry.Entries)(
					decoded,
				)
				const results = yield* Queue.make<{
					readonly url: string
					readonly path: `/${string}`
					readonly routes: Http.Routes["Service"]
				}>()
				const probe = Plugin.make({
					name: "probe",
					config: Schema.Struct({
						path: Schema.TemplateLiteral(["/", Schema.String]),
					}),
					inject: [Http.Server, Http.Routes],
					apply: ({ path }) =>
						Effect.gen(function* () {
							const api = HttpApi.make("probe").add(
								HttpApiGroup.make("probe").add(
									HttpApiEndpoint.get("get", path, { success: Schema.String }),
								),
							)
							yield* HttpApis.serve(
								api,
								["probe"],
								HttpApiBuilder.group(api, "probe", (h) =>
									h.handle("get", () => Effect.succeed(path)),
								),
							)
							if (page === "http-api") {
								const document = yield* capture(HttpApis.Document)
								yield* waitFor(document, ({ spec }) =>
									Record.has(spec.paths, path),
								)
								assert.deepStrictEqual(
									Record.keys(
										(yield* SubscriptionRef.get(document)).spec.paths,
									),
									[path],
								)
							}
							const server = yield* Http.Server
							const routes = yield* Http.Routes
							yield* Queue.offer(results, { url: server.url, path, routes })
						}),
				})
				const groups = yield* Effect.forEach(original, (entry, index) =>
					Effect.gen(function* () {
						const children = yield* Schema.decodeUnknownEffect(Entry.Entries)(
							entry.config,
						)
						return {
							...entry,
							config: [
								...children,
								{
									id: `probe-${index}`,
									name: "probe",
									config: { path: `/tenant-${index}` },
								},
							],
						}
					}),
				)
				return yield* Effect.gen(function* () {
					yield* (yield* Graft.plugin(Loader.plugin, groups)).await
					const served = yield* Effect.forEach(groups, () =>
						Queue.take(results),
					)
					for (const current of served) {
						const api = HttpApi.make("probe").add(
							HttpApiGroup.make("probe").add(
								HttpApiEndpoint.get("get", current.path, {
									success: Schema.String,
								}),
							),
						)
						const client = yield* HttpApiClient.make(api, {
							baseUrl: current.url,
						})
						const value = yield* client.probe.get()
						assert.strictEqual(value, current.path)
						for (const other of Array.filter(
							served,
							(other) => other !== current,
						)) {
							assert.notStrictEqual(current.routes, other.routes)
							assert.strictEqual(
								(yield* request(current.url + other.path)).status,
								404,
							)
						}
					}
				}).pipe(
					Effect.provide(
						Layer.provideMerge(
							Layer.fresh(Graft.layer),
							ModuleResolver.fromRecord({
								"@graftland/plugin-http": server,
								"@graftland/plugin-http/router": router,
								"@graftland/plugin-http-api": composer,
								"@graftland/plugin-http-api/scalar": scalar,
								probe,
							}),
						),
					),
				)
			}).pipe(
				Effect.scoped,
				Effect.provide([
					NodeServices.layer,
					FetchHttpClient.layer,
					ConfigProvider.layer(ConfigProvider.fromEnvRecord({ PORT: "0" })),
				]),
			),
	)
