/** The Node listener; other listeners inject Http.Routing with their own HttpServer. */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer requires a Node server factory
import { createServer } from "node:http"

import { Duration, Effect } from "effect"
import { HttpMiddleware, HttpServer } from "effect/http"
import { NodeHttpServer } from "@effect/platform-node"

import { Graft, Plugin } from "@graftland/graft"

import { Config } from "./Config"
import { Routing, Server } from "./Http"

export default Plugin.make({
	name: "@graftland/plugin-http",
	config: Config,
	inject: [Routing],
	apply: Effect.fnUntraced(function* ({ host, port }) {
		const server = yield* NodeHttpServer.make(() => createServer(), {
			host,
			port,
			gracefulShutdownTimeout: Duration.seconds(5),
		})
		const routing = yield* Routing
		// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- HttpServer reports heterogeneous application causes
		yield* HttpServer.serveEffect(routing.handle, HttpMiddleware.logger).pipe(
			Effect.provideService(HttpServer.HttpServer, server),
		)
		const url = HttpServer.formatAddress(server.address)
		yield* Effect.acquireRelease(Effect.log(`Listening on ${url}`), () =>
			Effect.log(`Stopped listening on ${url}`),
		)
		yield* Graft.provide(Server, { url, address: server.address })
	}),
})
