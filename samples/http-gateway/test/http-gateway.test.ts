import { assert, describe, it } from "@effect/vitest"
import { Graft, Plugin } from "@graftland/graft"
import { Loader, ModuleResolver } from "@graftland/loader"
import { Array, Context, Deferred, Effect, Layer, Stream, String } from "effect"
import type { Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Gateway } from "../src/Gateway.ts"
import health from "../src/plugins/health.ts"
import inspector from "../src/plugins/inspector.ts"
import server from "../src/plugins/server.ts"
import todoStore from "../src/plugins/todo-store.ts"
import todos from "../src/plugins/todos.ts"

// These tests open a real server on a free port and talk to it over HTTP.
const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		| Graft.Graft
		| Scope.Scope
		| HttpClient.HttpClient
		| ModuleResolver.ModuleResolver
	>,
) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(
				Layer.fresh(Graft.layer),
				Layer.mergeAll(
					FetchHttpClient.layer,
					ModuleResolver.fromRecord({
						"./src/plugins/server.ts": server,
						"./src/plugins/health.ts": health,
						"./src/plugins/inspector.ts": inspector,
						"./src/plugins/todo-store.ts": todoStore,
						"./src/plugins/todos.ts": todos,
					}),
				),
			),
		),
	)

/** Reads a service from the registry through a plugin that injects it. */
const capture = Effect.fn("capture")(function* <I, S>(key: Context.Key<I, S>) {
	const deferred = yield* Deferred.make<S>()
	yield* Graft.plugin(
		Plugin.make({
			name: `capture ${key.key}`,
			inject: [key],
			apply: () =>
				Effect.flatMap(Effect.service(key), (value) =>
					Effect.asVoid(Deferred.succeed(deferred, value)),
				),
		}),
	)
	return yield* Deferred.await(deferred)
})

const request = Effect.fn("request")(function* (
	method: "GET" | "POST",
	url: string,
	body?: unknown,
) {
	const client = yield* HttpClient.HttpClient
	const base =
		method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
	const response = yield* client.execute(
		body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body),
	)
	const text = yield* response.text
	return { status: response.status, text }
}, Effect.orDie)

const text = (entry: Graft.LogEntry) =>
	Array.join(
		Array.map(Array.ensure(entry.message), (part) => `${part}`),
		" ",
	)

const logged = Effect.fn("logged")(function* (message: string) {
	yield* Effect.log("end of log")
	const entries = yield* Stream.runCollect(
		Stream.takeUntil(Graft.logs, (entry) => text(entry) === "end of log"),
	)
	return Array.filter(entries, (entry) =>
		String.startsWith(message)(text(entry)),
	).length
})

describe("http-gateway", () => {
	it.live("adds and removes routes without restarting the server", () =>
		Effect.gen(function* () {
			yield* Graft.plugin(server, { port: 0 })
			const { url } = yield* capture(Gateway)
			const healthFork = yield* Graft.plugin(health)
			yield* healthFork.await
			const ok = yield* request("GET", `${url}/health`)
			assert.deepStrictEqual(ok, { status: 200, text: "ok\n" })

			yield* healthFork.dispose
			const gone = yield* request("GET", `${url}/health`)
			assert.strictEqual(gone.status, 404)
			const listens = yield* logged("Listening on")
			assert.strictEqual(listens, 1)
		}).pipe(run),
	)

	it.live("serves /todos only while a store is loaded", () =>
		Effect.gen(function* () {
			yield* Graft.plugin(server, { port: 0 })
			const { url } = yield* capture(Gateway)
			const todosFork = yield* Graft.plugin(todos)
			yield* todosFork.await
			const pending = yield* request("GET", `${url}/todos`)
			assert.strictEqual(pending.status, 404)

			const store = yield* Graft.plugin(todoStore, { seed: ["Ship it"] })
			yield* Effect.flatMap(
				Stream.runHead(
					Stream.filter(todosFork.state, (state) => state._tag === "Active"),
				),
				() => Effect.void,
			)
			const created = yield* request("POST", `${url}/todos`, {
				title: "Write docs",
			})
			assert.deepStrictEqual(created, {
				status: 201,
				text: '{"id":2,"title":"Write docs"}',
			})
			const invalid = yield* request("POST", `${url}/todos`, { name: 1 })
			assert.strictEqual(invalid.status, 400)
			const list = yield* request("GET", `${url}/todos`)
			assert.strictEqual(
				list.text,
				'[{"id":1,"title":"Ship it"},{"id":2,"title":"Write docs"}]',
			)

			yield* store.dispose
			const after = yield* request("GET", `${url}/todos`)
			assert.strictEqual(after.status, 404)
		}).pipe(run),
	)

	it.live("matches routes on the request path, whatever its shape", () =>
		Effect.gen(function* () {
			yield* Graft.plugin(server, { port: 0 })
			const { url } = yield* capture(Gateway)
			yield* Graft.plugin(todoStore, { seed: ["Ship it"] })
			const todosFork = yield* Graft.plugin(todos)
			yield* todosFork.await
			const ok = yield* request("GET", `${url}/todos`)
			assert.strictEqual(ok.status, 200)
			// A path that is not a valid relative URL matches no route.
			const malformed = yield* request("GET", `${url}//`)
			assert.strictEqual(malformed.status, 404)
			// A protocol-relative path must not resolve to another host's /todos.
			const elsewhere = yield* request("GET", `${url}//evil/todos`)
			assert.strictEqual(elsewhere.status, 404)
		}).pipe(run),
	)

	it.live("follows edits to the entries, like edits to graft.yml", () =>
		Effect.gen(function* () {
			yield* Graft.plugin(Loader.plugin, [
				{ id: "server", name: "./src/plugins/server.ts", config: { port: 0 } },
				{ id: "inspector", name: "./src/plugins/inspector.ts" },
				{
					id: "todo-store",
					name: "./src/plugins/todo-store.ts",
					config: { seed: ["Try the gateway"] },
				},
				{ id: "todos", name: "./src/plugins/todos.ts" },
			])
			const loader = yield* capture(Loader.Loader)
			yield* loader.ready
			const { url } = yield* capture(Gateway)
			const before = yield* request("GET", `${url}/todos`)
			assert.strictEqual(before.status, 200)

			yield* loader.update("todo-store", { disabled: true })
			yield* loader.ready
			const after = yield* request("GET", `${url}/todos`)
			assert.strictEqual(after.status, 404)
			const tree = yield* request("GET", `${url}/_graft`)
			assert.match(
				tree.text,
				/ todos #\d+: Pending \(waiting for @graftland\/sample-http-gateway\/TodoStore\)/,
			)
			// The server entry did not change, so it kept running.
			const listens = yield* logged("Listening on")
			assert.strictEqual(listens, 1)
		}).pipe(run),
	)
})
