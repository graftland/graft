import { Console, Effect, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

import { start } from "./app.js"

const program = Effect.gen(function* () {
	const app = yield* start(new URL("../../", import.meta.url).pathname, {
		_tag: "Worker",
		execArgv: [],
	})
	yield* Console.log(
		`Session: ${app.session}\nOperator: ${app.operatorUrl}\nPOST /upgrade/v2, /upgrade/broken-probe or /upgrade/broken-trial`,
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
