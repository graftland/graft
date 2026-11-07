/** In-memory sibling transport for plugin behavior tests. */
import { Deferred, Effect, Layer } from "effect"
import { McpServer, McpTest, type McpProtocol } from "effect/ai"

import { Plugin } from "@graftland/graft"

import { Server } from "../src/Server.ts"

/** Create inside a test scope, then load plugin beside the core and await client. */
export const transport = (
	options: {
		readonly protocolVersion?: McpProtocol.ProtocolVersion
		readonly name?: string
		readonly registry?: (
			server: McpServer.McpServer["Service"],
		) => McpServer.McpServer["Service"]
		readonly middleware?: Layer.Layer<never, never, McpServer.McpServer>
	} = {},
) =>
	Effect.gen(function* () {
		const ready = yield* Deferred.make<McpTest.Client>()
		const plugin = Plugin.make({
			name: options.name ?? "@graftland/plugin-mcp-server/testing",
			inject: [Server],
			apply: Effect.fnUntraced(function* () {
				const server = yield* Server
				const configuration = yield* server.options
				const registrations =
					options.registry === undefined
						? configuration.registrations
						: configuration.registrations.pipe(
								Layer.provide(
									Layer.effect(
										McpServer.McpServer,
										Effect.map(McpServer.McpServer, options.registry),
									),
								),
							)
				const client = yield* McpTest.makeClient(
					options.middleware === undefined
						? registrations
						: options.middleware.pipe(Layer.provideMerge(registrations)),
					{
						...configuration,
						protocolVersion: options.protocolVersion,
					},
				)
				yield* Deferred.succeed(ready, client)
			}),
		})
		return { plugin, client: Deferred.await(ready) }
	})
