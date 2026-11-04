import { SecureRandom } from "effect/crypto"
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
				Layer.provideMerge(
					Graft.layer,
					Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
				),
			)
			yield* Effect.forEach([Remote.local(), Remote.worker()], (target) =>
				Effect.gen(function* () {
					const reply = yield* formatInChild({
						contractModule: new URL("./contract.js", import.meta.url).href,
						target,
					})
					yield* Console.log(
						`${target._tag}: ${reply.text} (pid ${reply.pid}, thread ${reply.threadId}, host ${process.pid})`,
					)
				}).pipe(Effect.scoped, Effect.provideContext(context)),
			)
		}),
	),
)
