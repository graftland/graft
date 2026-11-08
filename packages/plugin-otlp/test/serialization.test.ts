// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer requires a Node server factory.
import { createServer } from "node:http"

import {
	Context,
	Deferred,
	Effect,
	Layer,
	Predicate,
	Queue,
	String,
} from "effect"
import {
	FetchHttpClient,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { NodeHttpServer } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import otlp from "@graftland/plugin-otlp"

import { fixture, moduleLayer } from "./module-fixtures"

for (const serialization of ["json", "protobuf"] as const) {
	for (const compression of ["none", "gzip"] as const) {
		it.live(`sends ${serialization} with ${compression} compression`, () =>
			Effect.gen(function* () {
				const traced = yield* Deferred.make<void>()
				return yield* Effect.gen(function* () {
					const received = yield* Queue.unbounded<{
						readonly contentType: string | undefined
						readonly encoding: string | undefined
						readonly bytes: Uint8Array
					}>()
					const node = createServer()
					const server = yield* NodeHttpServer.make(() => node, { port: 0 })
					yield* HttpServer.serveEffect()(
						Effect.gen(function* () {
							const request = yield* HttpServerRequest.HttpServerRequest
							const body = yield* request.arrayBuffer
							const bytes = new Uint8Array(body)
							yield* Queue.offer(received, {
								contentType: request.headers["content-type"],
								encoding: request.headers["content-encoding"],
								bytes,
							})
							return HttpServerResponse.empty()
						}),
					).pipe(Effect.provideService(HttpServer.HttpServer, server))
					const address = node.address()
					const port = Predicate.hasProperty(address, "port") ? address.port : 0
					const fork = yield* Graft.plugin(otlp, {
						url: `http://127.0.0.1:${port}/v1/traces`,
						serviceName: "test",
						serialization,
						compression,
						resource: { attributes: { padding: String.repeat(2000)("x") } },
						plugins: [{ name: "worker" }],
					})
					yield* fork.stable
					yield* Deferred.await(traced)
					yield* fork.dispose
					const batch = yield* Queue.take(received)
					assert.equal(
						batch.contentType,
						serialization === "json"
							? "application/json"
							: "application/x-protobuf",
					)
					assert.equal(
						batch.encoding,
						compression === "gzip" ? "gzip" : undefined,
					)
					assert.equal(
						batch.bytes[0],
						compression === "gzip"
							? 0x1f
							: serialization === "json"
								? 0x7b
								: 0x0a,
					)
					assert.isAbove(batch.bytes.length, 20)
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.fresh(Graft.layer).pipe(
							Layer.provideMerge(
								Layer.mergeAll(
									FetchHttpClient.layer,
									Layer.mergeAll(
										moduleLayer({
											"@graftland/plugin-otlp/http": fixture(
												"plugin-otlp-serialization-graftland-plugin-otlp-http-0",
											),
											worker: fixture("serialization-worker-2874"),
										}),
										Layer.succeed(
											Context.Service<{ readonly traced: typeof traced }>(
												"loader/fixture/serialization-worker-2874",
											),
											{ traced },
										),
									),
								),
							),
						),
					),
				)
			}),
		)
	}
}
