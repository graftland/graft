import {
	Array,
	ConfigProvider,
	Context,
	Effect,
	FileSystem,
	Layer,
	Queue,
	Schema,
} from "effect"
import { FetchHttpClient } from "effect/http"
import {
	HttpApi,
	HttpApiClient,
	HttpApiEndpoint,
	HttpApiGroup,
} from "effect/http-api"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import { Entry, Loader } from "@graftland/loader"
import * as Http from "@graftland/plugin-http/Http"

import { parse } from "yaml"

import { fixture, moduleLayer } from "./module-fixtures"
import { request } from "./utils.ts"

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
							Layer.mergeAll(
								moduleLayer({
									probe: fixture("documentation-probe-4199"),
								}),
								Layer.succeed(
									Context.Service<{
										readonly page: typeof page
										readonly results: typeof results
									}>("loader/fixture/documentation-probe-4199"),
									{ page, results },
								),
							),
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
