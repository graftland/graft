import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Graft, Plugin } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"
import { Effect, Layer, Option, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { contract, Greeter } from "../src/contract"

const consumer = Plugin.make({
	name: "caller",
	inject: [Greeter],
	apply: Effect.fn("caller.apply")(function* () {
		const greeter = yield* Greeter
		const greeting = yield* greeter.greet("Alice")
		assert.equal(greeting, "Hello, Alice!")
	}),
})

describe("06 · Remote", () => {
	for (const connect of [{ local: {} }, { worker: { execArgv: [] } }]) {
		it.live(
			`keeps the caller unchanged with ${"local" in connect ? "local" : "worker"}`,
			() =>
				Effect.gen(function* () {
					const provider = yield* Graft.plugin(
						Remote.plugin(contract, {
							contractModule: new URL(
								"../.cache/implementation/contract.js",
								import.meta.url,
							).href,
							connect,
							config: { greeting: "Hello" },
						}),
					)
					yield* provider.await
					const caller = yield* Graft.plugin(consumer)
					yield* caller.await
					const state = yield* Stream.runHead(caller.state)
					assert.deepEqual(state, Option.some({ _tag: "Active" }))
					yield* provider.dispose
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.provideMerge(
							Graft.layer,
							Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
						),
					),
				),
		)
	}
})
