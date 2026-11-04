/** Executable entry for a direct worker; platform services belong to this thread. */
import { Graft } from "@graftland/graft"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { parentPort, workerData } from "node:worker_threads"
import { load, run } from "./Runner"
import { Bootstrap } from "./internal/workerBootstrap"
import * as Channel from "./internal/workerChannel"
import { platform } from "./internal/platform"

const main = Effect.scoped(
	Effect.gen(function* () {
		const port = yield* Effect.fromNullishOr(parentPort)
		yield* Effect.addFinalizer(() => Effect.sync(() => port.close()))
		const bootstrap = yield* Schema.decodeUnknownEffect(Bootstrap)(workerData)
		const channel = yield* Channel.make(port)
		const contract = yield* load(bootstrap.contractModule)
		yield* run(contract, channel, bootstrap.session)
	}),
)
NodeRuntime.runMain(
	main.pipe(Effect.provide(Graft.layer.pipe(Layer.provide(platform)))),
)
