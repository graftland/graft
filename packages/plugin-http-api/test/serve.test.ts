import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Record,
	Ref,
	Schema,
	Stream,
	String,
	SubscriptionRef,
} from "effect"
import {
	HttpClient,
	HttpClientError,
	HttpClientRequest,
	HttpRouter,
	HttpServer,
	HttpServerResponse,
} from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiTest,
} from "effect/http-api"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import server from "@graftland/plugin-http"
import * as Http from "@graftland/plugin-http/Http"

import * as HttpApis from "../src/HttpApis.ts"
import composer from "../src/index.ts"
import scalar from "../src/scalar.ts"
import {
	capture,
	logs,
	logText,
	request,
	run,
	start,
	waitFor,
} from "./utils.ts"

class Missing extends Schema.TaggedError<
	Missing,
	{ readonly brand: unique symbol }
>()("Missing", { id: Schema.Int }, { httpApiStatus: 404 }) {}
const Todo = Schema.Struct({ id: Schema.Int, title: Schema.String })
const api = HttpApi.make("test").add(
	HttpApiGroup.make("todos").add(
		HttpApiEndpoint.post("create", "/todos", {
			payload: Schema.Struct({ title: Schema.String }),
			success: Todo,
		}),
		HttpApiEndpoint.get("list", "/todos", { success: Schema.Array(Todo) }),
		HttpApiEndpoint.get("get", "/todos/:id", {
			params: { id: Schema.Int },
			success: Todo,
			error: Missing,
		}),
	),
)
class Store extends Context.Service<
	Store,
	Ref.Ref<ReadonlyArray<typeof Todo.Type>>
>()("@graftland/plugin-http-api/test/serve.test/Store") {}
const handlers = HttpApiBuilder.group(api, "todos", (h) =>
	h
		.handle("create", ({ payload }) =>
			Effect.gen(function* () {
				const store = yield* Store
				const todos = yield* Ref.get(store)
				const todo = { id: todos.length + 1, title: payload.title }
				yield* Ref.update(store, (rows) => Array.append(rows, todo))
				yield* Effect.log("created todo")
				return todo
			}),
		)
		.handle("list", () => Effect.flatMap(Store, Ref.get))
		.handle("get", ({ params }) =>
			Effect.gen(function* () {
				const rows = yield* Effect.flatMap(Store, Ref.get)
				const todo = Array.findFirst(rows, (todo) => todo.id === params.id)
				return Option.isSome(todo)
					? todo.value
					: yield* Missing.make({ id: params.id })
			}),
		),
)
const feature = Plugin.make({
	name: "test-todos",
	inject: [Store],
	apply: () => HttpApis.serve(api, ["todos"], handlers),
})

it.live(
	"round-trips typed values and errors with injected services and plugin log annotations",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const ref = yield* Ref.make<ReadonlyArray<typeof Todo.Type>>([])
			const store = yield* Graft.plugin(
				Plugin.make({ name: "store", apply: () => Graft.provide(Store, ref) }),
			)
			yield* store.await
			const fork = yield* Graft.plugin(feature)
			yield* fork.await
			const client = yield* HttpApiClient.make(api, { baseUrl: url })
			const created = yield* client.todos.create({
				payload: { title: "First" },
			})
			const listed = yield* client.todos.list()
			const found = yield* client.todos.get({ params: { id: 1 } })
			assert.deepStrictEqual(created, { id: 1, title: "First" })
			assert.deepStrictEqual(listed, [created])
			assert.deepStrictEqual(found, created)
			const missing = yield* Effect.flip(
				client.todos.get({ params: { id: 99 } }),
			)
			assert.isTrue(Schema.is(Missing)(missing))
			const http = yield* HttpClient.HttpClient
			const invalid = yield* http.execute(
				HttpClientRequest.post(`${url}/todos`).pipe(
					HttpClientRequest.bodyJsonUnsafe({ title: 42 }),
				),
			)
			assert.strictEqual(invalid.status, 400)
			yield* invalid.text
			const entries = yield* logs
			const logged = Option.getOrThrow(
				Array.findFirst(entries, (entry) => logText(entry) === "created todo"),
			)
			assert.strictEqual(logged.annotations["graft.plugin"], "test-todos")
			assert.isEmpty(Array.filter(entries, (entry) => entry.level === "Error"))
			const validation = Option.getOrThrow(
				Array.findFirst(
					entries,
					(entry) => entry.annotations["http.status"] === 400,
				),
			)
			assert.strictEqual(validation.level, "Info")
			assert.include(Cause.pretty(validation.cause), "HttpApiSchemaError")
			yield* fork.dispose
			assert.strictEqual((yield* request(`${url}/todos`)).status, 404)
		}).pipe(run),
)

it.live(
	"serves selected groups separately and preserves API prefixes in routes and documents",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const a = HttpApiGroup.make("a").add(
				HttpApiEndpoint.get("get", "/a", { success: Schema.String }),
			)
			const b = HttpApiGroup.make("b").add(
				HttpApiEndpoint.get("get", "/b", { success: Schema.String }),
			)
			const prefixed = HttpApi.make("prefix").add(a, b).prefix("/v1")
			const doc = yield* Graft.plugin(composer, {})
			yield* doc.await
			const document = yield* capture(HttpApis.Document)
			const one = yield* Graft.plugin(
				Plugin.make({
					name: "one",
					apply: () =>
						HttpApis.serve(
							prefixed,
							["a"],
							HttpApiBuilder.group(prefixed, "a", (h) =>
								h.handle("get", () => Effect.succeed("a")),
							),
						),
				}),
			)
			yield* one.await
			assert.strictEqual((yield* request(`${url}/v1/b`)).status, 404)
			const two = yield* Graft.plugin(
				Plugin.make({
					name: "two",
					apply: () =>
						HttpApis.serve(
							prefixed,
							["b"],
							HttpApiBuilder.group(prefixed, "b", (h) =>
								h.handle("get", () => Effect.succeed("b")),
							),
						),
				}),
			)
			yield* two.await
			const client = yield* HttpApiClient.make(prefixed, { baseUrl: url })
			const av = yield* client.a.get(),
				bv = yield* client.b.get()
			assert.strictEqual(av, "a")
			assert.strictEqual(bv, "b")
			yield* waitFor(
				document,
				({ spec }) =>
					Record.has(spec.paths, "/v1/a") && Record.has(spec.paths, "/v1/b"),
			)
		}).pipe(run),
)

const simple = HttpApi.make("simple").add(
	HttpApiGroup.make("one").add(
		HttpApiEndpoint.get("get", "/one", { success: Schema.String }),
	),
)
const simplePlugin = (text: string) =>
	Plugin.make({
		name: "simple",
		apply: () =>
			HttpApis.serve(
				simple,
				["one"],
				HttpApiBuilder.group(simple, "one", (h) =>
					h.handle("get", () => Effect.succeed(text)),
				),
			),
	})
it.live("replaces and rolls back handlers", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const a = simplePlugin("first"),
			b = simplePlugin("second")
		const f = yield* Graft.plugin(a)
		yield* f.await
		const client = yield* HttpApiClient.make(simple, { baseUrl: url })
		const first = yield* client.one.get()
		assert.strictEqual(first, "first")
		assert.strictEqual((yield* Graft.replace([[a, b]]))._tag, "Replaced")
		const second = yield* client.one.get()
		assert.strictEqual(second, "second")
		const bad = Plugin.make({
			name: "bad",
			apply: () => Effect.die("replacement failed"),
		})
		assert.strictEqual((yield* Graft.replace([[b, bad]]))._tag, "RolledBack")
		const restored = yield* client.one.get()
		assert.strictEqual(restored, "second")
	}).pipe(run),
)

it.live("fails apply for duplicate method and path inside one serve", () =>
	Effect.gen(function* () {
		yield* start
		const duplicate = HttpApi.make("duplicate").add(
			HttpApiGroup.make("one").add(
				HttpApiEndpoint.get("a", "/one"),
				HttpApiEndpoint.get("b", "/one"),
			),
		)
		const f = yield* Graft.plugin(
			Plugin.make({
				name: "duplicate",
				apply: () =>
					HttpApis.serve(
						duplicate,
						["one"],
						HttpApiBuilder.group(duplicate, "one", (h) =>
							h.handle("a", () => Effect.void).handle("b", () => Effect.void),
						),
					),
			}),
		)
		const exit = yield* Effect.exit(f.await)
		assert.isTrue(Exit.isFailure(exit))
	}).pipe(run),
)

it.live(
	"preserves the injected FileSystem instead of the builder's no-op services",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const fs = FileSystem.makeNoop({
				readFileString: () => Effect.succeed("real filesystem"),
			})
			const provider = yield* Graft.plugin(
				Plugin.make({
					name: "filesystem",
					apply: () => Graft.provide(FileSystem.FileSystem, fs),
				}),
			)
			yield* provider.await
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "file-handler",
					inject: [FileSystem.FileSystem],
					apply: () =>
						HttpApis.serve(
							simple,
							["one"],
							HttpApiBuilder.group(simple, "one", (h) =>
								h.handle("get", () =>
									Effect.flatMap(FileSystem.FileSystem, (fs) =>
										fs.readFileString("fixture"),
									).pipe(Effect.orDie),
								),
							),
						),
				}),
			)
			yield* fork.await
			const client = yield* HttpApiClient.make(simple, { baseUrl: url })
			const value = yield* client.one.get()
			assert.strictEqual(value, "real filesystem")
		}).pipe(run),
)

for (const uninterruptible of [false, true])
	it.live(
		`owns slow handlers on unload (uninterruptible: ${uninterruptible})`,
		() =>
			Effect.gen(function* () {
				const { url } = yield* start
				const entered = yield* Deferred.make<void>(),
					finish = yield* Deferred.make<void>(),
					released = yield* Deferred.make<void>(),
					layerClosed = yield* Deferred.make<void>()
				const handler = Deferred.succeed(entered, undefined).pipe(
					Effect.andThen(Deferred.await(finish)),
					Effect.as("done"),
					Effect.ensuring(Deferred.succeed(released, undefined)),
				)
				const f = yield* Graft.plugin(
					Plugin.make({
						name: "slow",
						apply: () =>
							HttpApis.serve(
								simple,
								["one"],
								HttpApiBuilder.group(simple, "one", (h) =>
									h.handle("get", () => handler, { uninterruptible }),
								).pipe(
									Layer.provide(
										Layer.effectDiscard(
											Effect.addFinalizer(() =>
												Deferred.succeed(layerClosed, undefined),
											),
										),
									),
								),
							),
					}),
				)
				yield* f.await
				const client = yield* HttpApiClient.make(simple, { baseUrl: url })
				const call = yield* client.one.get().pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				const unload = yield* f.dispose.pipe(Effect.forkScoped)
				if (uninterruptible) {
					yield* Effect.gen(function* () {
						const routes = yield* capture(Http.Routes)
						yield* waitFor(routes, ({ served }) =>
							Array.every(served, (mount) =>
								Array.every(mount.routes, (route) => route.path !== "/one"),
							),
						)
						const stopped = yield* Deferred.isDone(released)
						assert.isFalse(stopped)
						const closed = yield* Deferred.isDone(layerClosed)
						assert.isFalse(closed)
						yield* Deferred.succeed(finish, undefined)
						const result = yield* Fiber.join(call)
						assert.strictEqual(result, "done")
					}).pipe(Effect.ensuring(Deferred.succeed(finish, undefined)))
				} else {
					const result = yield* Fiber.await(call)
					assert.isTrue(Exit.isFailure(result))
					if (Exit.isFailure(result)) {
						const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
						assert.isTrue(HttpClientError.isHttpClientError(error))
						if (
							HttpClientError.isHttpClientError(error) &&
							"response" in error.reason
						)
							assert.strictEqual(error.reason.response.status, 503)
						else
							assert.fail("Expected a response error carrying the 503 status")
					}
				}
				yield* Fiber.join(unload)
				const stopped = yield* Deferred.isDone(released),
					closed = yield* Deferred.isDone(layerClosed)
				assert.isTrue(stopped)
				assert.isTrue(closed)
			}).pipe(run),
	)

it.live(
	"keeps mounts, composer and UI activations across listener port changes and replacement",
	() =>
		Effect.gen(function* () {
			const { fork: listener } = yield* start
			const activations = yield* Ref.make({ mount: 0, composer: 0, ui: 0 })
			const count = (key: "mount" | "composer" | "ui") =>
				Ref.update(activations, (counts) => ({
					...counts,
					[key]: counts[key] + 1,
				}))
			const originalMount = simplePlugin("ok")
			const countedMount: typeof originalMount = {
				...originalMount,
				apply: (input) =>
					// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Plugin.apply erases requirements at its public activation boundary.
					count("mount").pipe(Effect.andThen(originalMount.apply(input))),
			}
			const countedComposer: typeof composer = {
				...composer,
				apply: (input) =>
					// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Plugin.apply erases requirements at its public activation boundary.
					count("composer").pipe(Effect.andThen(composer.apply(input))),
			}
			const countedUi: typeof scalar = {
				...scalar,
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Plugin.apply erases requirements at its public activation boundary.
				apply: (input) => count("ui").pipe(Effect.andThen(scalar.apply(input))),
			}
			const feature = yield* Graft.plugin(countedMount)
			yield* feature.await
			const doc = yield* Graft.plugin(countedComposer, {})
			yield* doc.await
			const view = yield* Graft.plugin(countedUi, {})
			yield* view.await
			const document = yield* capture(HttpApis.Document)
			const routes = yield* capture(Http.Routes)
			yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/one"))
			const beforeOption = yield* Stream.runHead(Graft.forks)
			const before = Option.getOrThrow(beforeOption)
			for (const change of [
				listener.update({ port: "0" }),
				Graft.replace([[server, { ...server, name: "third-party-listener" }]]),
			]) {
				yield* change
				yield* listener.await
				const { url } = yield* capture(Http.Server)
				const currentDocument = yield* capture(HttpApis.Document)
				const currentRoutes = yield* capture(Http.Routes)
				assert.strictEqual(currentDocument, document)
				assert.strictEqual(currentRoutes, routes)
				const currentActivations = yield* Ref.get(activations)
				assert.deepStrictEqual(currentActivations, {
					mount: 1,
					composer: 1,
					ui: 1,
				})
				const client = yield* HttpApiClient.make(simple, { baseUrl: url })
				const value = yield* client.one.get()
				assert.strictEqual(value, "ok")
				assert.strictEqual((yield* request(url + "/docs")).status, 200)
				const afterOption = yield* Stream.runHead(Graft.forks)
				const after = Option.getOrThrow(afterOption)
				for (const old of Array.filter(
					before,
					(node) =>
						node.id === feature.id ||
						node.id === doc.id ||
						node.id === view.id ||
						node.name === "@graftland/plugin-http/router",
				))
					assert.deepStrictEqual(
						Array.findFirst(after, (node) => node.id === old.id),
						Option.some(old),
					)
			}
			const { url } = yield* capture(Http.Server)
			const addedApi = HttpApi.make("new").add(
				HttpApiGroup.make("new").add(
					HttpApiEndpoint.get("get", "/new", { success: Schema.String }),
				),
			)
			const added = yield* Graft.plugin(
				Plugin.make({
					name: "new-group",
					apply: () =>
						HttpApis.serve(
							addedApi,
							["new"],
							HttpApiBuilder.group(addedApi, "new", (h) =>
								h.handle("get", () => Effect.succeed("new")),
							),
						),
				}),
			)
			yield* added.await
			yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/new"))
			const client = yield* HttpApiClient.make(addedApi, { baseUrl: url })
			const value = yield* client.new.get()
			assert.strictEqual(value, "new")
			const raw = yield* Graft.plugin(
				Plugin.make({
					name: "raw-conflict-after-restart",
					apply: () =>
						Http.mount(
							HttpRouter.add("GET", "/new", HttpServerResponse.empty()),
						).pipe(Effect.asVoid),
				}),
			)
			yield* raw.await
			yield* waitFor(document, ({ spec }) => !Record.has(spec.paths, "/new"))
			assert.strictEqual((yield* request(url + "/new")).status, 404)
			yield* raw.dispose
			yield* waitFor(document, ({ spec }) => Record.has(spec.paths, "/new"))
			const state = yield* SubscriptionRef.get(routes)
			assert.isEmpty(state.conflicts)
			const entries = yield* logs
			assert.lengthOf(
				Array.filter(entries, (entry) =>
					String.startsWith("Listening on")(logText(entry)),
				),
				3,
			)
		}).pipe(run),
)

it.effect("uses unchanged handler layers with HttpApiTest", () =>
	Effect.gen(function* () {
		const client = yield* HttpApiTest.groups(simple, ["one"]).pipe(
			Effect.provide(HttpServer.layerServices),
		)
		const value = yield* client.one.get()
		assert.strictEqual(value, "unit")
	}).pipe(
		Effect.provide(
			HttpApiBuilder.group(simple, "one", (h) =>
				h.handle("get", () => Effect.succeed("unit")),
			),
		),
	),
)
