import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Remote from "@graftland/remote"
import { Graft } from "@graftland/graft"
import { Console, Effect, Layer } from "effect"
import process from "node:process"
import { formatInChild } from "./host"

NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				Layer.provideMerge(Graft.layer, NodeServices.layer),
			)
			const reply = yield* formatInChild({
				contractModule: new URL("./contract.js", import.meta.url).href,
				target: Remote.local(),
			}).pipe(Effect.provideContext(context))
			yield* Console.log(
				`${reply.text} (child ${reply.pid}, host ${process.pid})`,
			)
		}),
	),
)
