import { Effect, Layer } from "effect"
import { McpServer } from "effect/ai"

import { Graft, Plugin } from "@graftland/graft"
import { Authorization } from "@graftland/plugin-http/Authorization"
import * as Http from "@graftland/plugin-http/Http"

import { HttpConfig } from "./Config"
import { Server } from "./Server"

const guarded = Plugin.make({
	name: "@graftland/plugin-mcp-server/http/guarded",
	config: HttpConfig,
	inject: [Server, Authorization],
	apply: Effect.fnUntraced(function* ({ path, allowedOrigins, authorization }) {
		const guard = (yield* Authorization).protect({
			path,
			scopes: authorization?.scopes ?? [],
		})
		yield* Http.mount(
			McpServer.layerHttp({
				...(yield* (yield* Server).options),
				allowSessionTermination: true,
				path,
				allowedOrigins,
			}).pipe(Layer.provide(guard.layer)),
		)
	}),
})

/** Streamable HTTP routes; listeners remain independent of this transport. */
export default Plugin.make({
	name: "@graftland/plugin-mcp-server/http",
	config: HttpConfig,
	inject: [Server],
	apply: Effect.fnUntraced(function* (config) {
		if (config.authorization !== undefined) {
			yield* Graft.plugin(guarded, config)
		} else {
			yield* Http.mount(
				McpServer.layerHttp({
					...(yield* (yield* Server).options),
					allowSessionTermination: true,
					path: config.path,
					allowedOrigins: config.allowedOrigins,
				}),
			)
		}
	}),
})
