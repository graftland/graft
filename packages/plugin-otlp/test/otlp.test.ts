// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer takes a factory for a Node server
import { createServer } from "node:http"

import {
	Array,
	Context,
	Effect,
	Layer,
	Logger,
	MutableRef,
	Option,
	Predicate,
	Queue,
	Redacted,
	Ref,
	Schema,
	Stream,
	String,
	type Scope,
} from "effect"
import {
	FetchHttpClient,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"
import * as Testing from "@graftland/plugin-otlp/Testing"

import { Http } from "../src/Config.ts"
import http from "../src/http.ts"
import otlp from "../src/index.ts"
import { fixture, moduleLayer } from "./module-fixtures"

const Span = Schema.Struct({
	name: Schema.String,
	attributes: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			value: Schema.Record(Schema.String, Schema.Unknown),
		}),
	),
})
const Export = Schema.Struct({
	resourceSpans: Schema.Array(
		Schema.Struct({
			resource: Schema.Struct({
				attributes: Schema.Array(
					Schema.Struct({
						key: Schema.String,
						value: Schema.Record(Schema.String, Schema.Unknown),
					}),
				),
			}),
			scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(Span) })),
		}),
	),
})

/** A collector that records the service and span names of each export. */
const collector = Effect.gen(function* () {
	const received = yield* Queue.unbounded<{
		readonly headers: Readonly<Record<string, string | undefined>>
		readonly attributes: ReadonlyArray<{
			readonly key: string
			readonly value: Readonly<Record<string, unknown>>
		}>
		readonly service: string
		readonly spans: ReadonlyArray<string>
	}>()
	const node = createServer()
	const server = yield* NodeHttpServer.make(() => node, { port: 0 })
	yield* HttpServer.serveEffect()(
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest
			const body = yield* request.json.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Export)),
				Effect.orDie,
			)
			for (const resource of body.resourceSpans) {
				const service = Option.getOrElse(
					Array.findFirst(
						resource.resource.attributes,
						(attribute) => attribute.key === "service.name",
					).pipe(
						Option.map((attribute) => `${attribute.value["stringValue"]}`),
					),
					() => "",
				)
				yield* Queue.offer(received, {
					headers: request.headers,
					attributes: resource.resource.attributes,
					service,
					spans: Array.flatMap(resource.scopeSpans, (scope) =>
						Array.map(scope.spans, (span) => span.name),
					),
				})
			}
			return HttpServerResponse.empty()
		}),
	).pipe(Effect.provideService(HttpServer.HttpServer, server))
	// The server's own address names the requested port, 0; ask Node for the bound one.
	const address = node.address()
	const port = Predicate.hasProperty(address, "port") ? address.port : 0
	return { received, url: `http://127.0.0.1:${port}/v1/traces` }
})

const quiet = (name: string) => Plugin.make({ name, apply: () => Effect.void })

const run = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
	plugins: Readonly<Record<string, string>>,
) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(
				Layer.fresh(Graft.layer),
				Layer.mergeAll(
					FetchHttpClient.layer,
					moduleLayer({
						...plugins,
						"@graftland/plugin-otlp/http": fixture(
							"plugin-otlp-tuning-graftland-plugin-otlp-http-1",
						),
					}),
				),
			),
		),
	)

describe("otlp", () => {
	it.live("exports the spans of its subtree, and only those", () =>
		Effect.gen(function* () {
			const { received, url } = yield* collector
			const outside = yield* Graft.plugin(quiet("outside"))
			yield* outside.await
			const fork = yield* Graft.plugin(otlp, {
				url,
				serviceName: "shop",
				plugins: [{ name: "inside" }],
			})
			yield* fork.stable
			// Disposing flushes the exporter.
			yield* fork.dispose
			const batch = yield* Queue.take(received)
			assert.strictEqual(batch.service, "shop")
			assert.isTrue(Array.contains(batch.spans, "graft.plugin inside"))
			assert.isFalse(Array.contains(batch.spans, "graft.plugin outside"))
		}).pipe((effect) =>
			run(effect, {
				inside: fixture("otlp-inside-factory-0"),
				outside: fixture("otlp-outside-factory-1"),
			}),
		),
	)

	it.live("swaps the endpoint without restarting the subtree", () => {
		const starts = Ref.makeUnsafe(0)

		return Effect.gen(function* () {
			const first = yield* collector
			const second = yield* collector
			const config = (url: string) => ({
				url,
				serviceName: "shop",
				plugins: [{ id: "counted", name: "counted" }],
			})
			const fork = yield* Graft.plugin(otlp, config(first.url))
			yield* fork.stable
			yield* fork.update(config(second.url))
			yield* fork.stable
			const count = yield* Ref.get(starts)
			assert.strictEqual(count, 1)
			// A swapped-out exporter keeps its spans and flushes when the plugin stops.
			yield* fork.dispose
			const flushed = yield* Queue.take(first.received)
			assert.isTrue(Array.contains(flushed.spans, "graft.plugin counted"))
		}).pipe((effect) =>
			run(effect, { counted: fixture("otlp-counted-5324") }).pipe(
				Effect.provideService(
					Context.Service<{ readonly starts: typeof starts }>(
						"loader/fixture/otlp-counted-5324",
					),
					{ starts },
				),
			),
		)
	})

	it.live("fails on an entry that is not an entry", () =>
		Effect.gen(function* () {
			const { url } = yield* collector
			const fork = yield* Graft.plugin(otlp, {
				url,
				serviceName: "shop",
				// @ts-expect-error -- Exercise runtime rejection of malformed external input.
				plugins: [{ config: 1 }],
			})
			const states = yield* fork.state.pipe(
				Stream.filter((state) => state._tag === "Failed"),
				Stream.runHead,
			)
			assert.isTrue(Option.isSome(states))
		}).pipe((effect) => run(effect, {})),
	)
})

it.live(
	"redacts headers in logs while sending credentials and resource attributes on the wire",
	() =>
		Effect.gen(function* () {
			const target = yield* collector
			const config = {
				url: target.url,
				serviceName: "shop",
				headers: { authorization: "Bearer test-secret" },
				resource: {
					serviceVersion: "1.2.3",
					attributes: { region: "west", replicas: 2 },
				},
				exportInterval: "60000",
				maxBatchSize: "100",
				shutdownTimeout: "2000",
			}
			const decoded = yield* Schema.decodeEffect(Http)(config)
			assert.isTrue(Redacted.isRedacted(decoded.headers["authorization"]))
			const logs = MutableRef.make<ReadonlyArray<string>>([])
			yield* Effect.log(decoded).pipe(
				Effect.provide(
					Logger.layer([
						Logger.map(Logger.formatJson, (line) =>
							MutableRef.update(logs, Array.append(line)),
						),
					]),
				),
			)
			const logged = Array.join(MutableRef.get(logs), "\n")
			assert.isTrue(String.includes("<redacted>")(logged))
			assert.isFalse(String.includes("test-secret")(logged))
			const fork = yield* Graft.plugin(otlp, {
				...config,
				plugins: [{ name: "inside" }],
			})
			yield* fork.stable
			yield* fork.dispose
			const batch = yield* Queue.take(target.received)
			assert.equal(batch.headers["authorization"], "Bearer test-secret")
			assert.deepInclude(batch.attributes, {
				key: "service.version",
				value: { stringValue: "1.2.3" },
			})
			assert.deepInclude(batch.attributes, {
				key: "region",
				value: { stringValue: "west" },
			})
			assert.deepInclude(batch.attributes, {
				key: "replicas",
				value: { intValue: 2 },
			})
		}).pipe((effect) =>
			run(effect, { inside: fixture("otlp-inside-factory-0") }),
		),
)

it.live(
	"passes the public exporter conformance kit with the HTTP implementation",
	() =>
		Effect.gen(function* () {
			const target = yield* collector
			yield* Testing.exporter({
				plugin: http,
				config: { url: target.url, serviceName: "test" },
				nextConfig: { url: target.url, serviceName: "updated" },
				received: Queue.clear(target.received).pipe(
					Effect.map(Array.flatMap((batch) => batch.spans)),
				),
			})
		}).pipe((effect) => run(effect, {})),
)
