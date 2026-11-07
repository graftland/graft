import process from "node:process"

import { Effect, Layer, Logger } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

import { load, run } from "./childRuntime"
import { bytes } from "./stdioChannel"

NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			const contract = yield* load(process.argv[2]!)
			const channel = yield* bytes
			return yield* run(contract, process.argv[3]!, channel, process.argv[4]!)
		}),
	).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This module is the sandbox process entry point.
		Effect.provide(Layer.provideMerge(Graft.layer, NodeServices.layer)),
		Effect.provideService(Logger.LogToStderr, true),
	),
)
