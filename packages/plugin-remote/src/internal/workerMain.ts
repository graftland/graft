/** Executable entry for a direct worker; platform services belong to this thread. */
import { Graft } from "@graftland/graft"
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Layer, Logger, Schema } from "effect"
import { parentPort, workerData } from "node:worker_threads"
import { load, run } from "./childRuntime"
import { Bootstrap } from "./workerBootstrap"
import * as Channel from "./workerChannel"
import { platform } from "./platform"

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
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				Graft.layer.pipe(Layer.provide(platform)),
			)
			return yield* main.pipe(Effect.provideContext(context))
		}),
	).pipe(
		Effect.tapCause((cause) =>
			Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause),
		),
		Effect.provideService(Logger.LogToStderr, true),
	),
	{ disableErrorReporting: true },
)
