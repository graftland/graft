import { SecureRandom } from "effect/crypto"
import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Graft } from "@graftland/graft"
import * as Remote from "@graftland/remote"
import { Effect, Layer } from "effect"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { formatInChild } from "../src/host"

const contractModule = new URL("../.cache/worker/contract.js", import.meta.url)
	.href
const bin = fileURLToPath(new URL("../.cache/runner/bin.js", import.meta.url))

describe("remote worker", () => {
	it.live(
		"calls the child service and waits for process exit on scope closure",
		() =>
			Effect.gen(function* () {
				const reply = yield* formatInChild({
					contractModule,
					target: Remote.local({ command: [process.execPath, bin] }),
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.provideMerge(
							Graft.layer,
							Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
						),
					),
				)
				assert.equal(reply.text, "Worker: HELLO")
				assert.notEqual(reply.pid, process.pid)
				assert.throws(() => process.kill(reply.pid, 0))
			}),
	)
})
