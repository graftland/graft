// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer takes a factory for a Node server
import { createServer } from "node:http"

import {
	Array,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Predicate,
	Queue,
	Ref,
	Schema,
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
import { ModuleResolver } from "@graftland/loader"

import http from "../src/http.ts"
import otlp from "../src/index.ts"

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

const run = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
	plugins: Readonly<Record<string, Plugin.Plugin>>,
) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(
				Layer.fresh(Graft.layer),
				Layer.mergeAll(
					FetchHttpClient.layer,
					ModuleResolver.fromRecord({
						...plugins,
						"@graftland/plugin-otlp/http": http,
					}),
				),
			),
		),
	)

describe("review regressions", () => {
	for (const swap of [false, true]) {
		it.live(`exports an in-flight span with exporter swap: ${swap}`, () => {
			const started = Deferred.makeUnsafe<void>()
			const finish = Deferred.makeUnsafe<void>()
			const completed = Deferred.makeUnsafe<void>()
			const worker = Plugin.make({
				name: "worker",
				apply: () =>
					Plugin.fork(
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Deferred.await(finish)),
							Effect.withSpan("across-swap"),
							Effect.andThen(Deferred.succeed(completed, undefined)),
						),
					).pipe(Effect.asVoid),
			})
			return Effect.gen(function* () {
				const first = yield* collector
				const second = yield* collector
				const config = (url: string) => ({
					url,
					serviceName: "shop",
					plugins: [{ name: "worker" }],
				})
				const fork = yield* Graft.plugin(otlp, config(first.url))
				yield* fork.stable
				yield* Deferred.await(started)
				if (swap) yield* fork.update(config(second.url))
				yield* Deferred.succeed(finish, undefined)
				yield* Deferred.await(completed)
				yield* fork.dispose
				const batches = [
					...(yield* Queue.clear(first.received)),
					...(yield* Queue.clear(second.received)),
				]
				assert.isTrue(
					Array.some(batches, (batch) =>
						Array.contains(batch.spans, "across-swap"),
					),
				)
			}).pipe((effect) => run(effect, { worker }))
		})
	}
})

it.live("reports an invalid explicit entry id on update", () => {
	const worker = Plugin.make({ name: "worker", apply: () => Effect.void })
	return Effect.gen(function* () {
		const { url } = yield* collector
		const config = {
			url,
			serviceName: "shop",
			plugins: [{ id: "0", name: "worker" }],
		}
		const fork = yield* Graft.plugin(otlp, config)
		yield* fork.stable
		// @ts-expect-error -- Exercise runtime rejection of malformed external input.
		yield* fork.update({ ...config, plugins: [{ id: 42, name: "worker" }] })
		yield* fork.stable
		const settled = yield* Effect.exit(fork.await)
		assert.isTrue(Exit.isFailure(settled))
	}).pipe((effect) => run(effect, { worker }))
})

it.live(
	"does not restart anonymous entries when a different name is inserted first",
	() => {
		const starts = Ref.makeUnsafe(0)
		const worker = Plugin.make({
			name: "worker",
			apply: () => Ref.update(starts, (count) => count + 1),
		})
		const other = Plugin.make({ name: "other", apply: () => Effect.void })
		return Effect.gen(function* () {
			const target = yield* collector
			const config = {
				url: target.url,
				serviceName: "test",
				plugins: [{ name: "worker" }],
			}
			const fork = yield* Graft.plugin(otlp, config)
			yield* fork.stable
			const count = yield* Ref.get(starts)
			assert.equal(count, 1)
			yield* fork.update({
				...config,
				plugins: [{ name: "other" }, { name: "worker" }],
			})
			yield* fork.stable
			const after = yield* Ref.get(starts)
			assert.equal(after, 1)
		}).pipe((effect) => run(effect, { worker, other }))
	},
)
