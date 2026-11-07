import {
	Array,
	Context,
	Deferred,
	Effect,
	FiberMap,
	Layer,
	Queue,
	Ref,
	Stream,
	String,
	type Scope,
} from "effect"
import { McpClient, McpProtocol, McpSchema } from "effect/ai"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

import { Graft, Plugin } from "@graftland/graft"
import listener from "@graftland/plugin-http"
import * as Http from "@graftland/plugin-http/Http"
import router from "@graftland/plugin-http/router"

import http from "../src/http.ts"
import * as Testing from "../src/Testing.ts"

export const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		Graft.Graft | Scope.Scope | HttpClient.HttpClient
	>,
) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(Layer.fresh(Graft.layer), FetchHttpClient.layer),
		),
	)

export const capture = Effect.fnUntraced(function* <I, S>(
	key: Context.Key<I, S>,
) {
	const ready = yield* Deferred.make<S>()
	yield* (yield* Graft.plugin(
		Plugin.make({
			name: "test/http/capture",
			inject: [key],
			apply: () =>
				Effect.flatMap(Effect.service(key), (value) =>
					Deferred.succeed(ready, value).pipe(Effect.asVoid),
				),
		}),
	)).await
	return yield* Deferred.await(ready)
})
export const start = Effect.gen(function* () {
	yield* (yield* Graft.plugin(router)).await
	const listening = yield* Graft.plugin(listener, { port: 0 })
	yield* listening.await
	return { listening, ...(yield* capture(Http.Server)) }
})

/** Headers are defined by MCP 2026-07-28 transports and effect/ai/internal/mcpRuntime.ts. */
export const headers = (
	message: McpSchema.JsonRpcMessage,
): Record<string, string> => {
	if (!("method" in message)) return {}
	const name =
		message.method === "resources/read"
			? message.params?.["uri"]
			: message.method === "tools/call" || message.method === "prompts/get"
				? message.params?.["name"]
				: undefined
	return {
		"mcp-protocol-version":
			((message.params?.["_meta"] as Record<string, unknown> | undefined)?.[
				"io.modelcontextprotocol/protocolVersion"
			] as string | undefined) ?? "2026-07-28",
		"mcp-method": message.method,
		...(typeof name === "string" ? { "mcp-name": name } : {}),
	}
}
export const post = Effect.fnUntraced(function* (
	url: string,
	message: McpSchema.JsonRpcMessage,
	extra?: Record<string, string>,
) {
	const client = yield* HttpClient.HttpClient
	return yield* client.execute(
		HttpClientRequest.post(url).pipe(
			HttpClientRequest.bodyJsonUnsafe(message),
			HttpClientRequest.setHeaders({
				accept: "application/json, text/event-stream",
				...(extra ?? headers(message)),
			}),
		),
	)
})
export const rpc = Effect.fnUntraced(function* (
	url: string,
	method: string,
	params: Record<string, unknown> = {},
	extra?: Record<string, string>,
) {
	const message = {
		jsonrpc: "2.0" as const,
		id: 1,
		method,
		params: { _meta: Testing.metadata, ...params },
	}
	const response = yield* post(url, message, extra)
	const text = yield* response.text
	const data = String.startsWith("data:")(text)
		? String.trim(
				String.slice(5)(
					Array.filter(String.split(text, "\n"), String.startsWith("data:")).at(
						-1,
					)!,
				),
			)
		: text
	const body = data === "" ? undefined : yield* Testing.decode(data)
	return { status: response.status, headers: response.headers, body }
})

/** Real HTTP connection for the wire-level kit. Cancelling a modern HTTP call aborts its POST. */
export const connection = Effect.fnUntraced(function* (url: string) {
	const client = yield* HttpClient.HttpClient
	const requests = yield* FiberMap.make<string | number, void>()
	const output = yield* Queue.unbounded<McpSchema.JsonRpcMessage>()
	const ended = yield* Ref.make(false)
	const session = yield* Ref.make<string | undefined>(undefined)
	const send: Testing.Connection["send"] = (message) =>
		Effect.gen(function* () {
			if ("method" in message && message.method === "notifications/cancelled") {
				yield* FiberMap.remove(
					requests,
					message.params?.["requestId"] as string | number,
				)
				return
			}
			const request = Effect.gen(function* () {
				const modern =
					"method" in message &&
					(message.params?.["_meta"] as Record<string, unknown> | undefined)?.[
						"io.modelcontextprotocol/protocolVersion"
					] !== undefined
				const id = yield* Ref.get(session)
				const response = yield* post(
					url,
					message,
					modern
						? headers(message)
						: id === undefined
							? {}
							: { "mcp-session-id": id, "mcp-protocol-version": "2025-11-25" },
				)
				if (response.headers["mcp-session-id"] !== undefined)
					yield* Ref.set(session, response.headers["mcp-session-id"])
				if (
					String.includes("text/event-stream")(
						response.headers["content-type"] ?? "",
					)
				) {
					yield* response.stream.pipe(
						Stream.decodeText(),
						Stream.splitLines,
						Stream.filter(String.startsWith("data:")),
						Stream.runForEach((line) =>
							Testing.decode(String.trim(String.slice(5)(line))).pipe(
								Effect.flatMap((frame) => Queue.offer(output, frame)),
							),
						),
					)
				} else {
					const text = yield* response.text
					if (text !== "") {
						const decoded = yield* Testing.decode(text)
						yield* Queue.offer(output, decoded)
					}
				}
			}).pipe(
				Effect.provideService(HttpClient.HttpClient, client),
				Effect.orDie,
			)
			yield* FiberMap.run(
				requests,
				"id" in message ? message.id : "notification",
				request,
			)
		})
	const connected: Testing.Connection = {
		send,
		receive: Queue.take(output),
		end: FiberMap.clear(requests).pipe(Effect.andThen(Ref.set(ended, true))),
		closed: Effect.gen(function* () {
			if (yield* Ref.get(ended)) return
			// A disconnected POST alone does not prove withdrawal: the route must be gone too.
			const response = yield* client.get(url)
			yield* response.text
			if (response.status !== 404) return yield* Effect.never
		}).pipe(Effect.orDie),
	}
	return connected
})
export const adapter = (url: string) => ({
	plugin: Plugin.make({
		name: "test/http",
		apply: () =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(http, {})).await
			}),
	}),
	client: connection(url),
})

export const mcpClient = Effect.fnUntraced(function* (
	url: string,
	protocol: typeof McpProtocol.v2026_07_28 | typeof McpProtocol.v2025_11_25,
	headers?: Record<string, string>,
) {
	const context = yield* Layer.build(
		// @effect-diagnostics-next-line experimentalApiUsage:off -- the requested interoperability test uses Effect's public MCP client
		McpClient.layerHttp({
			name: "http-test",
			version: "1",
			url,
			protocol,
			headers,
		}),
	)
	// @effect-diagnostics-next-line experimentalApiUsage:off -- the requested interoperability test uses Effect's public MCP client
	return Context.get(context, McpClient.McpClient)
})
export const names = (tools: ReadonlyArray<McpSchema.Tool>) =>
	Array.map(tools, (tool) => tool.name)

export const httpTransport = Effect.gen(function* () {
	const { url } = yield* start
	return adapter(url + "/mcp")
})
