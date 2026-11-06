import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Layer,
	Option,
	Record,
	Schema,
	Stream,
	String,
	SubscriptionRef,
} from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpApiEndpoint,
	HttpApiGroup,
	OpenApi,
} from "effect/http-api"
import { assert, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

import * as HttpApis from "../src/HttpApis.ts"
import composer from "../src/index.ts"
import { compose } from "../src/internal/compose.ts"
import { ui } from "../src/internal/ui.ts"
import scalar from "../src/scalar.ts"
import swagger from "../src/swagger.ts"
import {
	capture,
	logs,
	logText,
	request,
	run,
	start,
	waitFor,
} from "./utils.ts"

export const feature = (id: string, path: `/${string}`) => {
	const api = HttpApi.make("test")
		.add(
			HttpApiGroup.make(id).add(
				HttpApiEndpoint.get("get", path, { success: Schema.String }),
			),
		)
		.annotate(OpenApi.Title, "Source title")
	const plugin = Plugin.make({
		name: `feature-${path}`,
		apply: () =>
			HttpApis.serve(
				api,
				[id],
				HttpApiBuilder.group(api, id, (h) =>
					h.handle("get", () => Effect.succeed(path)),
				),
			),
	})
	return { api, plugin }
}
const setup = Effect.gen(function* () {
	const listener = yield* start
	const fork = yield* Graft.plugin(composer, {
		title: "Combined",
		version: "2",
		description: "Live",
		servers: [{ url: "https://example.com" }],
	})
	yield* fork.await
	const document = yield* capture(HttpApis.Document)
	return { ...listener, composer: fork, document }
})
const has =
	(path: string) =>
	({ spec }: HttpApis.Snapshot) =>
		Record.has(spec.paths, path)

it.live(
	"adds and removes groups live without restarting either fork and preserves group tags",
	() =>
		Effect.gen(function* () {
			const { url, document } = yield* setup
			const before = yield* Stream.runHead(Graft.forks)
			const f = feature("todos", "/todos")
			const mounted = yield* Graft.plugin(f.plugin)
			yield* mounted.await
			yield* waitFor(document, has("/todos"))
			const client = yield* HttpApiClient.make(f.api, { baseUrl: url })
			const value = yield* client["todos"]!.get()
			assert.strictEqual(value, "/todos")
			const snapshot = yield* SubscriptionRef.get(document)
			assert.deepStrictEqual(snapshot.spec.info, {
				title: "Combined",
				version: "2",
				description: "Live",
			})
			assert.deepStrictEqual(snapshot.spec.servers, [
				{ url: "https://example.com" },
			])
			assert.deepStrictEqual(
				Array.map(snapshot.spec.tags, (tag) => tag.name),
				["todos"],
			)
			assert.include((yield* request(`${url}/openapi.json`)).text, '"/todos"')
			yield* mounted.dispose
			yield* waitFor(document, (s) => !has("/todos")(s))
			assert.notInclude(
				(yield* request(`${url}/openapi.json`)).text,
				'"/todos"',
			)
			const currentDocument = yield* capture(HttpApis.Document)
			assert.strictEqual(currentDocument, document)
			const after = yield* Stream.runHead(Graft.forks)
			for (const node of Array.filter(
				Option.getOrThrow(before),
				(node) =>
					node.name === "@graftland/plugin-http" ||
					node.name === "@graftland/plugin-http-api",
			))
				assert.deepStrictEqual(
					Array.findFirst(Option.getOrThrow(after), (n) => n.id === node.id),
					Option.some(node),
				)
			const entries = yield* logs
			assert.isFalse(
				Array.some(entries, (entry) =>
					String.includes("Several plugins mount")(logText(entry)),
				),
			)
		}).pipe(run),
)

it.live(
	"documents neither duplicate identifier but serves both, then restores the survivor",
	() =>
		Effect.gen(function* () {
			const { url, document } = yield* setup
			const left = feature("duplicate", "/left"),
				right = feature("duplicate", "/right")
			const a = yield* Graft.plugin(left.plugin)
			yield* a.await
			yield* waitFor(document, has("/left"))
			const b = yield* Graft.plugin(right.plugin)
			yield* b.await
			yield* waitFor(document, (s) => !has("/left")(s))
			const l = yield* HttpApiClient.make(left.api, { baseUrl: url })
			const r = yield* HttpApiClient.make(right.api, { baseUrl: url })
			const lv = yield* l["duplicate"]!.get(),
				rv = yield* r["duplicate"]!.get()
			assert.strictEqual(lv, "/left")
			assert.strictEqual(rv, "/right")
			const snapshot = yield* SubscriptionRef.get(document)
			assert.isFalse(Record.has(snapshot.spec.paths, "/right"))
			const entries = yield* logs
			assert.isTrue(
				Array.some(entries, (entry) =>
					Array.some(
						Array.ensure(entry.message),
						Schema.is(HttpApis.GroupConflict),
					),
				),
			)
			yield* b.dispose
			yield* waitFor(document, has("/left"))
		}).pipe(run),
)

it.live(
	"removes documentation for a route conflict with a raw mount and restores it",
	() =>
		Effect.gen(function* () {
			const { url, document } = yield* setup
			const f = feature("todos", "/todos")
			const a = yield* Graft.plugin(f.plugin)
			yield* a.await
			yield* waitFor(document, has("/todos"))
			const raw = yield* Graft.plugin(
				Plugin.make({
					name: "raw",
					apply: () =>
						Http.mount(
							HttpRouter.add("GET", "/todos", HttpServerResponse.empty()),
						).pipe(Effect.asVoid),
				}),
			)
			yield* raw.await
			yield* waitFor(document, (s) => !has("/todos")(s))
			assert.strictEqual((yield* request(`${url}/todos`)).status, 404)
			yield* raw.dispose
			yield* waitFor(document, has("/todos"))
			const client = yield* HttpApiClient.make(f.api, { baseUrl: url })
			const value = yield* client["todos"]!.get()
			assert.strictEqual(value, "/todos")
		}).pipe(run),
)

for (const [name, plugin] of [
	["scalar", scalar],
	["swagger", swagger],
] as const)
	it.live(
		`serves ${name} at its configured path, follows changes, and unloads independently`,
		() =>
			Effect.gen(function* () {
				const { url, document } = yield* setup
				const view = yield* Graft.plugin(plugin, { path: "/reference" })
				yield* view.await
				const initial = yield* request(`${url}/reference`)
				assert.strictEqual(initial.status, 200)
				assert.include(initial.text, "Combined")
				const f = feature("added", "/added")
				const mounted = yield* Graft.plugin(f.plugin)
				yield* mounted.await
				yield* waitFor(document, has("/added"))
				const updated = yield* request(`${url}/reference`).pipe(
					Effect.repeat({ until: (r) => String.includes("/added")(r.text) }),
					Effect.timeout("3 seconds"),
				)
				assert.include(updated.text, "/added")
				yield* view.dispose
				assert.strictEqual((yield* request(`${url}/reference`)).status, 404)
				assert.strictEqual((yield* request(`${url}/openapi.json`)).status, 200)
			}).pipe(run),
	)

it.live(
	"keeps contributions active when a UI refresh fails and reports the cause",
	() =>
		Effect.gen(function* () {
			const { url, document } = yield* setup
			const custom = Plugin.make({
				name: "failing-ui",
				inject: [HttpApis.Document],
				apply: () =>
					ui("/custom", (api) =>
						Record.has(api.groups, "added")
							? Layer.effectDiscard(Effect.die("UI asset failed"))
							: HttpRouter.add(
									"GET",
									"/custom",
									HttpServerResponse.text("previous"),
								),
					),
			})
			const view = yield* Graft.plugin(custom)
			yield* view.await
			const f = feature("added", "/added")
			const mounted = yield* Graft.plugin(f.plugin)
			yield* mounted.await
			yield* waitFor(document, has("/added"))
			yield* Stream.runHead(
				Stream.filter(Graft.logs, (entry) =>
					String.includes("UI asset failed")(Cause.pretty(entry.cause)),
				),
			)
			assert.strictEqual((yield* request(`${url}/custom`)).text, "previous")
			const client = yield* HttpApiClient.make(f.api, { baseUrl: url })
			const value = yield* client["added"]!.get()
			assert.strictEqual(value, "/added")
			yield* mounted.dispose
		}).pipe(run),
)

it.live(
	"logs failed group answers with their cause while documenting the other groups",
	() =>
		Effect.gen(function* () {
			const { document } = yield* setup
			const bad = yield* Graft.plugin(
				Plugin.make({
					name: "bad-answer",
					apply: () =>
						Event.on(HttpApis.Groups, () => Effect.die("group answer failed")),
				}),
			)
			yield* bad.await
			const f = yield* Graft.plugin(feature("good", "/good").plugin)
			yield* f.await
			yield* waitFor(document, has("/good"))
			const entries = yield* logs
			assert.isTrue(
				Array.some(entries, (entry) =>
					String.includes("group answer failed")(Cause.pretty(entry.cause)),
				),
			)
		}).pipe(run),
)

it.live("honors disabled routes and the composer is optional", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const f = feature("independent", "/independent")
		const fork = yield* Graft.plugin(f.plugin)
		yield* fork.await
		const client = yield* HttpApiClient.make(f.api, { baseUrl: url })
		const value = yield* client["independent"]!.get()
		assert.strictEqual(value, "/independent")
		const doc = yield* Graft.plugin(composer, { openapi: false })
		yield* doc.await
		assert.strictEqual((yield* request(`${url}/openapi.json`)).status, 404)
		assert.strictEqual((yield* request(`${url}/docs`)).status, 404)
	}).pipe(run),
)

it.effect(
	"sorts tags and schema components independently of contribution order",
	() =>
		Effect.gen(function* () {
			const a = HttpApiGroup.make("a").add(
				HttpApiEndpoint.get("get", "/a", {
					success: Schema.Struct({ a: Schema.String }).annotate({
						identifier: "User",
					}),
				}),
			)
			const b = HttpApiGroup.make("b").add(
				HttpApiEndpoint.get("get", "/b", {
					success: Schema.Struct({ b: Schema.String }).annotate({
						identifier: "User",
					}),
				}),
			)
			const left = yield* Effect.fromResult(compose([a, b]))
			const right = yield* Effect.fromResult(compose([b, a]))
			assert.deepStrictEqual(left.spec, right.spec)
			assert.deepStrictEqual(
				Array.map(left.spec.tags, (tag) => tag.name),
				["a", "b"],
			)
		}),
)

it.effect(
	"retains the original cause of operationId conflicts and exposes composition",
	() =>
		Effect.gen(function* () {
			const a = HttpApiGroup.make("a").add(
				HttpApiEndpoint.get("get", "/a", { success: Schema.String }).annotate(
					OpenApi.Identifier,
					"duplicate",
				),
			)
			const b = HttpApiGroup.make("b").add(
				HttpApiEndpoint.get("get", "/b", { success: Schema.String }).annotate(
					OpenApi.Identifier,
					"duplicate",
				),
			)
			const result = yield* Effect.fromResult(compose([a, b], Context.empty()))
			assert.deepStrictEqual(result.spec.paths, {})
			assert.instanceOf(result.conflicts[0]?.cause, Error)
			assert.include(
				`${result.conflicts[0]?.cause}`,
				"Duplicate OpenAPI operationId",
			)
		}),
)

it.live("does not make group startup wait for document composition", () =>
	Effect.gen(function* () {
		const { url } = yield* setup
		const release = yield* Deferred.make<void>()
		const blocker = yield* Graft.plugin(
			Plugin.make({
				name: "slow-answer",
				apply: () =>
					Event.on(HttpApis.Groups, () =>
						Deferred.await(release).pipe(Effect.as([])),
					),
			}),
		)
		yield* blocker.await
		const f = feature("nonblocking", "/nonblocking")
		const mounted = yield* Graft.plugin(f.plugin)
		yield* mounted.await.pipe(
			Effect.timeout("1 second"),
			Effect.ensuring(Deferred.succeed(release, undefined)),
		)
		const client = yield* HttpApiClient.make(f.api, { baseUrl: url })
		const response = yield* client["nonblocking"]!.get()
		assert.strictEqual(response, "/nonblocking")
	}).pipe(run),
)

it.live(
	"keeps the document identical across both live contribution orders",
	() =>
		Effect.gen(function* () {
			const { url, document } = yield* setup
			const group = <const N extends "a" | "b">(name: N) =>
				HttpApiGroup.make(name).add(
					HttpApiEndpoint.get("get", `/${name}`, {
						success: Schema.Struct({ value: Schema.Literal(name) }).annotate({
							identifier: "Shared",
						}),
					}),
				)
			const a = HttpApi.make("a").add(group("a"))
			const b = HttpApi.make("b").add(group("b"))
			const first = Plugin.make({
				name: "a",
				apply: () =>
					HttpApis.serve(
						a,
						["a"],
						HttpApiBuilder.group(a, "a", (h) =>
							h.handle("get", () => Effect.succeed({ value: "a" as const })),
						),
					),
			})
			const second = Plugin.make({
				name: "b",
				apply: () =>
					HttpApis.serve(
						b,
						["b"],
						HttpApiBuilder.group(b, "b", (h) =>
							h.handle("get", () => Effect.succeed({ value: "b" as const })),
						),
					),
			})
			const left = yield* Graft.plugin(first)
			yield* left.await
			const right = yield* Graft.plugin(second)
			yield* right.await
			yield* waitFor(document, (s) => has("/a")(s) && has("/b")(s))
			const before = (yield* SubscriptionRef.get(document)).spec
			yield* left.dispose
			yield* right.dispose
			yield* waitFor(document, (s) => !has("/a")(s) && !has("/b")(s))
			const reversedRight = yield* Graft.plugin(second)
			yield* reversedRight.await
			const reversedLeft = yield* Graft.plugin(first)
			yield* reversedLeft.await
			yield* waitFor(document, (s) => has("/a")(s) && has("/b")(s))
			assert.deepStrictEqual(
				(yield* SubscriptionRef.get(document)).spec,
				before,
			)
			const ac = yield* HttpApiClient.make(a, { baseUrl: url })
			const bc = yield* HttpApiClient.make(b, { baseUrl: url })
			const av = yield* ac.a.get()
			const bv = yield* bc.b.get()
			assert.deepStrictEqual(av, { value: "a" })
			assert.deepStrictEqual(bv, { value: "b" })
		}).pipe(run),
)
