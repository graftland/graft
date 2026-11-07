import { Deferred, Effect, Stdio } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import listener from "@graftland/plugin-http"
import * as Http from "@graftland/plugin-http/Http"
import router from "@graftland/plugin-http/router"
import mcp from "@graftland/plugin-mcp-server"
import http from "@graftland/plugin-mcp-server/http"
import * as Projection from "@graftland/plugin-mcp-server/Projection"
import stdio from "@graftland/plugin-mcp-server/stdio"

import { Forecast, Get } from "@example/forecast-contract"

import { policy, type start } from "./app.js"

export const view = (version: string, title = "City forecast") =>
	Projection.operation(
		Forecast,
		Get.annotate(Projection.Annotation, {
			name: "forecast",
			title,
			description: `Read the ${version} city forecast`,
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
			output: "json",
		}),
		(forecast, { city }) => forecast.get(city),
	)

/** A host-owned view of the same injected facade used by the bot consumer. */
export const expose = Effect.fnUntraced(function* (
	app: Effect.Success<ReturnType<typeof start>>,
	transport: "http" | "stdio" = "http",
) {
	const ready = yield* Deferred.make<Projection.Controller<Forecast>>()
	yield* (yield* Graft.plugin(
		Plugin.make({
			name: "forecast-mcp-tools",
			inject: [Forecast],
			apply: () =>
				Effect.gen(function* () {
					const controller = yield* Projection.offer("forecast-tools", [
						view("v1"),
					])
					yield* Deferred.succeed(ready, controller)
				}),
		}),
	)).await
	yield* (yield* Graft.plugin(mcp, { protocols: ["2025-11-25"] })).await
	const url = yield* transport === "stdio"
		? Effect.gen(function* () {
				const streams = yield* Stdio.Stdio
				yield* Graft.provide(Stdio.Stdio, streams)
				yield* (yield* Graft.plugin(stdio, {})).await
				return "stdio"
			})
		: Effect.gen(function* () {
				yield* (yield* Graft.plugin(router)).await
				yield* (yield* Graft.plugin(listener, { port: 0 })).await
				const address = yield* Deferred.make<string>()
				yield* (yield* Graft.plugin(
					Plugin.make({
						name: "forecast-mcp-address",
						inject: [Http.Server],
						apply: () =>
							Effect.gen(function* () {
								const server = yield* Http.Server
								yield* Deferred.succeed(address, server.url + "/mcp")
							}),
					}),
				)).await
				yield* (yield* Graft.plugin(http, {})).await
				return yield* Deferred.await(address)
			})
	const controller = yield* Deferred.await(ready)
	return {
		url,
		controller,
		upgrade: (title = "City forecast") =>
			controller.updateAfter(
				Graft.transition({
					target: "forecasts",
					candidate: app.candidate("v2"),
					policy,
				}),
				[view("v2", title)],
				(outcome) => outcome._tag === "Accepted",
			),
	}
})
