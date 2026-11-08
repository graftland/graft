/** Executable inspection boundary: each invocation has a fresh transitive module cache. */
import { parentPort, workerData } from "node:worker_threads"

import { Effect, Schema } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { inspect } from "./publicationInspection"
import { Request, Response } from "./publicationProtocol"

const main = Effect.scoped(
	Effect.gen(function* () {
		const port = yield* Effect.fromNullishOr(parentPort)
		yield* Effect.addFinalizer(() => Effect.sync(() => port.close()))
		const result = yield* Effect.exit(
			Effect.gen(function* () {
				const request = yield* Schema.decodeUnknownEffect(Request)(workerData)
				return yield* inspect(request.directory, request.entry)
			}),
		)
		const encoded = yield* Schema.encodeEffect(Response)(result)
		yield* Effect.sync(() => port.postMessage(encoded))
	}),
)

if (import.meta.main)
	NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)))
