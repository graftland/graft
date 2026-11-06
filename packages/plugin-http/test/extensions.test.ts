import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Record,
	Path as ResolverPath,
	Schema,
	SubscriptionRef,
} from "effect"
import { FetchHttpClient, HttpRouter, HttpServerResponse } from "effect/http"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"

import * as Http from "../src/Http.ts"
import server from "../src/index.ts"
import * as entryModule from "../src/index.ts"
import router from "../src/router.ts"
import * as Testing from "../src/Testing.ts"
import { capture, logs, request, run, start } from "./utils.ts"

it.live("passes the public listener conformance kit", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		yield* Testing.listener(url)
	}).pipe(run),
)

it.live(
	"publishes structured conflicts with original causes and excludes invalid manual mounts",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const state = yield* capture(Http.Routes)
			const good = yield* Graft.plugin(
				Plugin.make({
					name: "valid-manual-neighbor",
					apply: () =>
						Http.mount(
							HttpRouter.add("GET", "/good", HttpServerResponse.text("good")),
						).pipe(Effect.asVoid),
				}),
			)
			yield* good.await
			const invalid = yield* Graft.plugin(
				Plugin.make({
					name: "invalid",
					apply: () =>
						Http.advertise({
							routes: [
								{ method: "GET", path: "/x" },
								{ method: "GET", path: "/x" },
							],
							handle: Effect.succeed(HttpServerResponse.empty()),
						}),
				}),
			)
			yield* invalid.await
			assert.strictEqual((yield* request(`${url}/x`)).status, 404)
			const current = yield* SubscriptionRef.get(state)
			assert.lengthOf(current.served, 1)
			assert.strictEqual((yield* request(`${url}/good`)).text, "good")
			assert.lengthOf(current.conflicts, 1)
			assert.instanceOf(current.conflicts[0]?.cause, Error)
			const entries = yield* logs
			assert.isTrue(
				Array.some(entries, (entry) =>
					Array.some(Array.ensure(entry.message), Schema.is(Http.InvalidMount)),
				),
			)
			assert.isFalse(
				Array.some(entries, (entry) =>
					Array.some(
						Array.ensure(entry.message),
						Schema.is(Http.RouteConflict),
					),
				),
			)
			yield* invalid.dispose
			const empty = yield* SubscriptionRef.get(state)
			assert.isEmpty(empty.conflicts)
		}).pipe(run),
)

it.live("isolates listeners, mounts and observable state", () =>
	Effect.gen(function* () {
		const left = yield* Deferred.make<string>(),
			right = yield* Deferred.make<string>()
		const tenant = (path: `/${string}`, result: Deferred.Deferred<string>) =>
			Plugin.make({
				name: path,
				apply: () =>
					Effect.gen(function* () {
						yield* (yield* Graft.plugin(router)).await
						yield* Graft.plugin(server, { port: 0 })
						const address = yield* capture(Http.Server)
						yield* Http.mount(
							HttpRouter.add("GET", path, HttpServerResponse.text(path)),
						)
						yield* Deferred.succeed(result, address.url)
					}),
			})
		const isolate = [
			Http.Server,
			Http.Mounts,
			Http.MountsChanged,
			Http.Routes,
			Http.Routing,
		]
		const a = yield* Graft.plugin(tenant("/left", left), undefined, { isolate })
		const b = yield* Graft.plugin(tenant("/right", right), undefined, {
			isolate,
		})
		yield* a.await
		yield* b.await
		const l = yield* Deferred.await(left),
			r = yield* Deferred.await(right)
		assert.notStrictEqual(l, r)
		assert.strictEqual((yield* request(`${l}/left`)).status, 200)
		assert.strictEqual((yield* request(`${l}/right`)).status, 404)
		assert.strictEqual((yield* request(`${r}/right`)).status, 200)
		assert.strictEqual((yield* request(`${r}/left`)).status, 404)
	}).pipe(run),
)

it.live("rejects a second listener in one realm", () =>
	Effect.gen(function* () {
		yield* start
		const second = yield* Graft.plugin(server, { port: 0 })
		const result = yield* Effect.exit(second.await)
		assert.isTrue(Exit.isFailure(result))
		if (Exit.isFailure(result))
			assert.include(Cause.pretty(result.cause), "ServiceConflict")
	}).pipe(run),
)

for (const name of ["http", "@graftland/plugin-http"])
	it.live(`loads ${name} through real Loader candidates`, () =>
		Effect.gen(function* () {
			const result =
				yield* Deferred.make<Context.Service.Shape<typeof Loader.Loader>>()
			yield* Graft.plugin(
				Plugin.make({
					name: "capture-loader",
					inject: [Loader.Loader],
					apply: () =>
						Effect.flatMap(Loader.Loader, (value) =>
							Deferred.succeed(result, value),
						).pipe(Effect.asVoid),
				}),
			)
			const f = yield* Graft.plugin(Loader.plugin, [
				{ id: "router", name: "@graftland/plugin-http/router" },
				{ id: "http", name, config: { port: "0" } },
			])
			yield* f.await
			const loader = yield* Deferred.await(result)
			yield* loader.ready
			const { url } = yield* capture(Http.Server)
			assert.strictEqual((yield* request(`${url}/missing`)).status, 404)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.provideMerge(
					Layer.fresh(Graft.layer),
					Layer.merge(
						FetchHttpClient.layer,
						Layer.effect(
							ModuleResolver.ModuleResolver,
							ModuleResolver.make({
								base: "/",
								importer: (specifier) => {
									const modules: Readonly<Record<string, unknown>> = {
										http: {},
										"@graftland/plugin-http": { default: server },
										"@graftland/plugin-http/router": { default: router },
									}
									return Effect.fromOption(
										Record.get(modules, specifier),
										() => ({
											code: "ERR_MODULE_NOT_FOUND",
											message: "Cannot find package '" + specifier + "'",
										}),
									)
								},
							}),
						).pipe(Layer.provide(ResolverPath.layer)),
					),
				),
			),
		),
	)

it("exports only the default plugin at the package root", () =>
	// @effect-diagnostics-next-line preferEffectRecord:off -- test the exact runtime ESM namespace exports requested by the package contract
	assert.deepStrictEqual(Object.keys(entryModule), ["default"]))

it("exposes listener plugins rather than a public serve function", () =>
	assert.notProperty(Http, "serve"))
