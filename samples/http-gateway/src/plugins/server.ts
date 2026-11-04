import { NodeHttpServer } from "@effect/platform-node"
import { Event, Graft, Plugin } from "@graftland/graft"
import { Effect, Option, Schema } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer takes a factory for a Node server
import { createServer } from "node:http"
import { Gateway, Route } from "../Gateway.ts"

/**
 * Listens on `port` and asks the loaded routes to answer each request. It
 * knows nothing about them: route plugins come and go without restarting the
 * server, and changing the port restarts the server without touching them.
 */
export default Plugin.make({
	name: "server",
	config: Schema.Struct({ port: Schema.Int }),
	apply: Effect.fn("server.apply")(function* ({ port }) {
		const server = yield* NodeHttpServer.make(() => createServer(), {
			port,
		})
		const handler = Effect.flatMap(
			HttpServerRequest.HttpServerRequest,
			(request) =>
				Effect.map(
					Event.bail(Route, request),
					Option.getOrElse(() =>
						HttpServerResponse.text("Not found\n", { status: 404 }),
					),
				),
		)
		yield* HttpServer.serveEffect()(handler).pipe(
			Effect.provideService(HttpServer.HttpServer, server),
		)
		const url =
			server.address._tag === "UnixPathAddress"
				? HttpServer.formatAddress(server.address)
				: `http://localhost:${server.address.port}`
		yield* Effect.acquireRelease(Effect.log(`Listening on ${url}`), () =>
			Effect.log(`Stopped listening on ${url}`),
		)
		yield* Graft.provide(Gateway, { url })
	}),
})
