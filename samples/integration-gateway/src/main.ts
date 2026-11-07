import { Console, Deferred, Effect, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import type { Controller } from "@graftland/plugin-mcp-server/Projection"

import { Forecast } from "@example/forecast-contract"

import { start } from "./app.js"
import { expose, view } from "./mcp.js"

const program = Effect.gen(function* () {
	const ready = yield* Deferred.make<Controller<Forecast>>()
	const app = yield* start(
		new URL("../../", import.meta.url).pathname,
		{
			_tag: "Worker",
			execArgv: [],
		},
		(release, action) =>
			Deferred.await(ready).pipe(
				Effect.flatMap((controller) =>
					controller.updateAfter(
						action,
						[view(release)],
						(outcome) => outcome._tag === "Accepted",
					),
				),
			),
	)
	const endpoint = yield* expose(app)
	yield* Deferred.succeed(ready, endpoint.controller)

	yield* Console.log(
		`Session: ${app.session}\nOperator: ${app.operatorUrl}\nMCP: ${endpoint.url}\nPOST /upgrade/v2, /upgrade/broken-probe or /upgrade/broken-trial`,
	)
	const reply = yield* app.ask("example", "London")
	yield* Console.log(reply)
	return yield* Effect.never
})
NodeRuntime.runMain(
	program.pipe(
		Effect.scoped,
		Effect.provide(
			Graft.layer.pipe(
				Layer.provideMerge(
					Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
				),
			),
		),
	),
)
