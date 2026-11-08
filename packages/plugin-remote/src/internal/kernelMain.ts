/** Fixed metadata bootstrap. Business code is imported only by native units. */
import process from "node:process"

import { Array, Effect, FileSystem, Layer, Schema } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import * as Kernel from "@graftland/graft/Kernel"

import * as Control from "../Control"
import * as Units from "../Units"
import * as Limit from "./encodedLimit"

const deployment = Effect.fnUntraced(function* () {
	const args = yield* Effect.sync(() => Array.drop(process.argv, 2))
	const file = yield* Effect.fromOption(Array.get(args, 0))
	const ready = yield* Effect.fromOption(Array.get(args, 1))
	const fs = yield* FileSystem.FileSystem
	const text = yield* fs.readFileString(file)
	yield* Limit.check(text)
	const value = yield* Schema.decodeEffect(
		Schema.fromJsonString(Control.Deployment),
	)(text)
	return { value, ready }
})
const listen = Effect.fnUntraced(function* (ready: string) {
	const fs = yield* FileSystem.FileSystem
	const address = yield* Control.serve()
	const text = yield* Schema.encodeEffect(
		Schema.fromJsonString(Control.Address),
	)(address)
	yield* fs.writeFileString(ready, text)
	return yield* Effect.never
})
const main = Effect.gen(function* () {
	const config = yield* deployment()
	return yield* listen(config.ready).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This fixed executable is the composition root for the data-selected kernel deployment.
		Effect.provide(Kernel.layer(config.value).pipe(Layer.provide(Units.layer))),
	)
}).pipe(
	Effect.scoped,
	// @effect-diagnostics-next-line strictEffectProvide:off -- This executable owns the platform layer for its entire lifetime.
	Effect.provide(NodeServices.layer),
)

if (import.meta.main) NodeRuntime.runMain(main)
