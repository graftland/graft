import {
	Array,
	Cause,
	Effect,
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

import { vi } from "vitest"

import * as HttpApis from "../src/HttpApis.ts"
import { CompositionError } from "../src/HttpApis.ts"
import composer from "../src/index.ts"
import {
	capture,
	logs,
	logText,
	request,
	run,
	start,
	waitFor,
} from "./utils.ts"

// @effect-diagnostics-next-line asyncFunction:off -- Vitest requires a Promise factory to replace an ESM dependency
vi.mock("effect/http-api", async () => {
	const actual =
		await vi.importActual<typeof import("effect/http-api")>("effect/http-api")
	return {
		...actual,
		OpenApi: { ...actual.OpenApi, fromApi: vi.fn(actual.OpenApi.fromApi) },
	}
})
const feature = (
	id: string,
	path: `/${string}`,
	schema = Schema.String as Schema.Codec<string>,
) => {
	const api = HttpApi.make(id).add(
		HttpApiGroup.make(id)
			.annotate(OpenApi.Transform, (tag) => {
				if (id === "broken")
					throw new Error("Unsupported custom document annotation")
				return tag
			})
			.add(HttpApiEndpoint.get("get", path, { success: schema })),
	)
	return {
		api,
		plugin: Plugin.make({
			name: path,
			apply: () =>
				HttpApis.serve(
					api,
					[id],
					HttpApiBuilder.group(api, id, (h) =>
						h.handleRaw("get", () =>
							Effect.succeed(HttpServerResponse.jsonUnsafe("ok")),
						),
					),
				),
		}),
	}
}
const setup = Effect.gen(function* () {
	const listener = yield* start
	yield* (yield* Graft.plugin(composer, {})).await
	return { ...listener, document: yield* capture(HttpApis.Document) }
})
const count = (
	entries: ReadonlyArray<Graft.LogEntry>,
	schema: typeof Http.RouteConflict | typeof HttpApis.GroupConflict,
) =>
	Array.filter(entries, (entry) =>
		Array.some(Array.ensure(entry.message), Schema.is(schema)),
	).length

it.live(
	"logs each route and group conflict once until it clears and returns",
	() =>
		Effect.gen(function* () {
			const { document } = yield* setup
			const left = yield* Graft.plugin(feature("duplicate", "/left").plugin)
			yield* left.await
			const second = feature("duplicate", "/right").plugin
			let right = yield* Graft.plugin(second)
			yield* right.await
			yield* waitFor(document, ({ spec }) => !Record.has(spec.paths, "/left"))
			const raw = Plugin.make({
				name: "raw",
				apply: () =>
					Http.mount(
						HttpRouter.add("GET", "/left", HttpServerResponse.empty()),
					).pipe(Effect.asVoid),
			})
			let conflict = yield* Graft.plugin(raw)
			yield* conflict.await
			// The group conflict clears while the raw route conflict filters out /left.
			yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/right"))
			for (const id of ["a", "b", "c"]) {
				yield* (yield* Graft.plugin(feature(id, `/${id}`).plugin)).await
				yield* waitFor(document, ({ spec }) => Record.has(spec.paths, `/${id}`))
			}
			let entries = yield* logs
			assert.strictEqual(count(entries, Http.RouteConflict), 1)
			assert.strictEqual(count(entries, HttpApis.GroupConflict), 1)
			yield* conflict.dispose
			yield* waitFor(document, ({ spec }) => !Record.has(spec.paths, "/right"))
			for (const id of ["d", "e"]) {
				yield* (yield* Graft.plugin(feature(id, `/${id}`).plugin)).await
				yield* waitFor(document, ({ spec }) => Record.has(spec.paths, `/${id}`))
			}
			entries = yield* logs
			assert.strictEqual(count(entries, HttpApis.GroupConflict), 2)
			conflict = yield* Graft.plugin(raw)
			yield* conflict.await
			yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/right"))
			entries = yield* logs
			assert.strictEqual(count(entries, Http.RouteConflict), 2)
			yield* conflict.dispose
			yield* right.dispose
		}).pipe(run),
)

it.live(
	"serves a group whose schema cannot be documented and logs its cause only once",
	() =>
		Effect.gen(function* () {
			const { url, document } = yield* setup
			const broken = feature(
				"broken",
				"/broken",
				Schema.declare((input): input is string => typeof input === "string"),
			)
			const fork = yield* Graft.plugin(broken.plugin)
			yield* fork.await
			const good = feature("good", "/good")
			yield* (yield* Graft.plugin(good.plugin)).await
			yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/good"))
			const client = yield* HttpApiClient.make(broken.api, { baseUrl: url })
			const value = yield* client["broken"]!.get()
			assert.strictEqual(value, "ok")
			assert.notInclude((yield* request(url + "/openapi.json")).text, "/broken")
			for (const id of ["extra", "another"]) {
				yield* (yield* Graft.plugin(feature(id, `/${id}`).plugin)).await
				yield* waitFor(document, ({ spec }) => Record.has(spec.paths, `/${id}`))
			}
			const entries = yield* logs
			const brokenLogs = Array.filter(entries, (entry) =>
				String.includes("Could not document group broken")(logText(entry)),
			)
			assert.lengthOf(brokenLogs, 1)
			assert.isNotEmpty(Cause.pretty(brokenLogs[0]!.cause))
		}).pipe(run),
)

it.live(
	"retains the last good HTTP document after composition fails and recovers on a later change",
	() =>
		Effect.gen(function* () {
			const original = vi.mocked(OpenApi.fromApi).getMockImplementation()!
			const { url, document } = yield* setup
			for (const id of ["a", "b"]) {
				yield* (yield* Graft.plugin(feature(id, `/${id}`).plugin)).await
				yield* waitFor(document, ({ spec }) => Record.has(spec.paths, `/${id}`))
			}
			const previous = yield* SubscriptionRef.get(document)
			const cause = new Error("three-way generation failure")
			vi.mocked(OpenApi.fromApi).mockImplementation((api) => {
				if (Record.keys(api.groups).length >= 3) throw cause
				return original(api)
			})
			yield* Effect.addFinalizer(() =>
				Effect.sync(() =>
					vi.mocked(OpenApi.fromApi).mockImplementation(original),
				),
			)
			const third = feature("c", "/c")
			yield* (yield* Graft.plugin(third.plugin)).await
			yield* Stream.runHead(
				Stream.filter(Graft.logs, (entry) =>
					Array.some(
						Array.ensure(entry.message),
						(message) =>
							Schema.is(CompositionError)(message) && message.cause === cause,
					),
				),
			)
			const retained = yield* SubscriptionRef.get(document)
			assert.strictEqual(retained, previous)
			assert.notInclude((yield* request(url + "/openapi.json")).text, "/c")
			const client = yield* HttpApiClient.make(third.api, { baseUrl: url })
			const response = yield* client["c"]!.get()
			assert.strictEqual(response, "ok")
			vi.mocked(OpenApi.fromApi).mockImplementation(original)
			yield* Event.emit(HttpApis.GroupsChanged)
			yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/c"))
			assert.include((yield* request(url + "/openapi.json")).text, "/c")
		}).pipe(run),
)
