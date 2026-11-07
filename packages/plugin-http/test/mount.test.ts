import {
	Array,
	Context,
	Effect,
	Layer,
	Option,
	Ref,
	Stream,
	String,
} from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as Http from "../src/Http.ts"
import { capture, logs, logText, request, run, start } from "./utils.ts"

const route = (path: HttpRouter.PathInput, text = path) =>
	Plugin.make({
		name: "route",
		apply: () =>
			Http.mount(
				HttpRouter.add("GET", path, HttpServerResponse.text(text)),
			).pipe(Effect.asVoid),
	})

it.live("withdraws a mount on unload without restarting the listener", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const fork = yield* Graft.plugin(route("/x"))
		yield* fork.await
		assert.strictEqual((yield* request(`${url}/x`)).text, "/x")
		yield* fork.dispose
		assert.strictEqual((yield* request(`${url}/x`)).status, 404)
		const entries = yield* logs
		assert.lengthOf(
			Array.filter(entries, (entry) =>
				String.startsWith("Listening on")(logText(entry)),
			),
			1,
		)
	}).pipe(run),
)

it.live("restarts only the server on a port change", () =>
	Effect.gen(function* () {
		const activations = yield* Ref.make(0)
		const mounted = yield* Graft.plugin(
			Plugin.make({
				name: "persistent",
				apply: () =>
					Ref.update(activations, (n) => n + 1).pipe(
						Effect.andThen(
							Http.mount(
								HttpRouter.add("GET", "/x", HttpServerResponse.text("ok")),
							).pipe(Effect.asVoid),
						),
					),
			}),
		)
		yield* mounted.await
		const { fork, url, address } = yield* start
		assert.strictEqual(address._tag, "InetAddressV4")
		const beforeSnapshot = yield* Stream.runHead(Graft.forks)
		const before = Option.getOrThrow(beforeSnapshot)
		assert.strictEqual((yield* request(`${url}/x`)).status, 200)
		// Switch from an assigned fixed port to a fresh OS-assigned port.
		if (address._tag === "InetAddressV4") {
			yield* fork.update({ port: address.port })
			yield* fork.await
		}
		yield* fork.update({ port: 0 })
		yield* fork.await
		const current = yield* capture(Http.Server)
		assert.notStrictEqual(current.url, url)
		const entries = yield* logs
		assert.lengthOf(
			Array.filter(entries, (entry) =>
				String.startsWith("Listening on")(logText(entry)),
			),
			3,
		)
		assert.strictEqual((yield* request(`${current.url}/x`)).text, "ok")
		const count = yield* Ref.get(activations)
		assert.strictEqual(count, 1)
		const afterSnapshot = yield* Stream.runHead(Graft.forks)
		const after = Option.getOrThrow(afterSnapshot)
		assert.deepStrictEqual(
			Array.findFirst(after, (node) => node.id === mounted.id),
			Array.findFirst(before, (node) => node.id === mounted.id),
		)
	}).pipe(run),
)

it.live("replaces routes and restores them after rollback", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const first = route("/old"),
			next = route("/new")
		const fork = yield* Graft.plugin(first)
		yield* fork.await
		assert.strictEqual((yield* Graft.replace([[first, next]]))._tag, "Replaced")
		assert.strictEqual((yield* request(`${url}/old`)).status, 404)
		assert.strictEqual((yield* request(`${url}/new`)).status, 200)
		const broken = Plugin.make({
			name: "broken",
			apply: () =>
				Http.mount(
					HttpRouter.add("GET", "/broken", HttpServerResponse.empty()),
				).pipe(Effect.asVoid, Effect.andThen(Effect.die("replacement failed"))),
		})
		assert.strictEqual(
			(yield* Graft.replace([[next, broken]]))._tag,
			"RolledBack",
		)
		assert.strictEqual((yield* request(`${url}/new`)).status, 200)
		assert.strictEqual((yield* request(`${url}/broken`)).status, 404)
	}).pipe(run),
)

it.live("indexes root, parameters, nested prefixes, and HEAD fallback", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "paths",
				apply: () =>
					Http.mount(
						Layer.mergeAll(
							HttpRouter.add("GET", "/", HttpServerResponse.text("root")),
							HttpRouter.use((router) =>
								router
									.prefixed("/admin/")
									.prefixed("/v1")
									.add(
										"GET",
										"/users/:id",
										Effect.map(HttpRouter.RouteContext, ({ params }) =>
											HttpServerResponse.text(params["id"] ?? "missing"),
										),
									),
							),
						),
					).pipe(Effect.asVoid),
			}),
		)
		yield* fork.await
		assert.strictEqual((yield* request(`${url}/`)).text, "root")
		assert.strictEqual((yield* request(`${url}/admin/v1/users/42`)).text, "42")
		assert.strictEqual((yield* request(`${url}/users/42`)).status, 404)
		const head = yield* request(`${url}/admin/v1/users/42`, "HEAD")
		assert.strictEqual(head.status, 200)
		assert.strictEqual(head.text, "")
	}).pipe(run),
)

class Message extends Context.Service<Message, string>()(
	"@graftland/plugin-http/test/mount.test/Message",
) {}
it.live("captures injected services while preserving request services", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const provider = yield* Graft.plugin(
			Plugin.make({
				name: "message",
				apply: () => Graft.provide(Message, "injected"),
			}),
		)
		yield* provider.await
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "consumer",
				inject: [Message],
				apply: () =>
					Http.mount(
						HttpRouter.add(
							"GET",
							"/service",
							Effect.map(Message, HttpServerResponse.text),
						),
					).pipe(Effect.asVoid),
			}),
		)
		yield* fork.await
		assert.strictEqual((yield* request(`${url}/service`)).text, "injected")
	}).pipe(run),
)

it.live("returns an empty 404 without error-level logs", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const response = yield* request(`${url}/missing`)
		assert.strictEqual(response.status, 404)
		assert.strictEqual(response.text, "")
		const entries = yield* logs
		assert.isEmpty(Array.filter(entries, (entry) => entry.level === "Error"))
	}).pipe(run),
)

it.live("delegates CORS preflight to the sole path owner", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "cors",
				apply: () =>
					Http.mount(
						Layer.merge(
							HttpRouter.add("GET", "/cors", HttpServerResponse.text("ok")),
							HttpRouter.cors({ allowedOrigins: ["https://example.com"] }),
						),
					).pipe(Effect.asVoid),
			}),
		)
		yield* fork.await
		const response = yield* request(`${url}/cors`, "OPTIONS", {
			origin: "https://example.com",
			"access-control-request-method": "GET",
		})
		assert.strictEqual(response.status, 204)
		assert.strictEqual(
			response.headers["access-control-allow-origin"],
			"https://example.com",
		)
	}).pipe(run),
)

class RequestName extends Context.Service<RequestName, string>()(
	"@graftland/plugin-http/test/mount.test/RequestName",
) {}

it.live("keeps middleware and request services local to their mount", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const guard = HttpRouter.middleware((app) =>
			Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
				request.headers["authorization"] === "allowed"
					? app
					: Effect.succeed(HttpServerResponse.empty({ status: 401 })),
			),
		)
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "guarded",
				apply: () =>
					Http.mount(
						HttpRouter.add(
							"GET",
							"/guarded",
							Effect.gen(function* () {
								const name = yield* RequestName
								const request = yield* HttpServerRequest.HttpServerRequest
								return HttpServerResponse.text(
									`${name}:${request.headers["x-name"]}`,
								)
							}),
						).pipe(
							HttpRouter.provideRequest(Layer.succeed(RequestName, "provided")),
							Layer.provide(guard.layer),
						),
					).pipe(Effect.asVoid),
			}),
		)
		yield* fork.await
		const publicFork = yield* Graft.plugin(route("/public"))
		yield* publicFork.await
		assert.strictEqual((yield* request(`${url}/guarded`)).status, 401)
		assert.strictEqual(
			(yield* request(`${url}/guarded`, "GET", {
				authorization: "allowed",
				"x-name": "Alice",
			})).text,
			"provided:Alice",
		)
		assert.strictEqual(
			(yield* request(`${url}/guarded`, "GET", {
				authorization: "allowed",
				"x-name": "Bob",
			})).text,
			"provided:Bob",
		)
		assert.strictEqual((yield* request(`${url}/public`)).status, 200)
	}).pipe(run),
)

it.live("does not delegate a method miss to an ambiguous path owner", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		for (const method of ["GET", "POST"] as const) {
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: method,
					apply: () =>
						Http.mount(
							Layer.merge(
								HttpRouter.add(
									method,
									"/shared",
									HttpServerResponse.text(method),
								),
								HttpRouter.cors(),
							),
						).pipe(Effect.asVoid),
				}),
			)
			yield* fork.await
		}
		assert.strictEqual(
			(yield* request(`${url}/shared`, "OPTIONS", {
				origin: "https://example.com",
				"access-control-request-method": "GET",
			})).status,
			404,
		)
		assert.strictEqual((yield* request(`${url}/shared`)).text, "GET")
		assert.strictEqual((yield* request(`${url}/shared`, "POST")).text, "POST")
	}).pipe(run),
)
