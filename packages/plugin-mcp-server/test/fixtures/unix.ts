/** Third-party fixture: only installed public package subpaths. */
import { Effect, Layer, Schema } from "effect"
import { McpServer } from "effect/ai"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { NodeSocketServer } from "@effect/platform-node"

import { Plugin } from "@graftland/graft"
import { Server } from "@graftland/plugin-mcp-server/Server"

export default Plugin.make({
	name: "@acme/graft-plugin-mcp-unix",
	config: Schema.Struct({ path: Schema.String }),
	inject: [Server],
	apply: Effect.fnUntraced(function* ({ path }) {
		const options = yield* (yield* Server).options
		yield* Layer.build(
			McpServer.layer(options).pipe(
				Layer.provide(
					RpcServer.layerProtocolSocketServer.pipe(
						Layer.provide([
							NodeSocketServer.layer({ path }),
							RpcSerialization.layerNdJsonRpc(),
						]),
					),
				),
			),
		)
	}),
})
