import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Result } from "effect"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { crypto } from "../src/credentials.ts"
import { demo } from "../src/host.ts"
import * as Lab from "../src/lab.ts"

const local = (relative: string) =>
	fileURLToPath(new URL(relative, import.meta.url))

describe("remote runner", () => {
	it.live(
		"admits a larger generation after a host restart and fences the older one",
		() =>
			Effect.gen(function* () {
				const environment = yield* Lab.start({
					directory: local("../.cache/test-lab"),
					// Run the installed copy of this test's own build, so its children
					// resolve the same executable instead of the package's dist output.
					runner: local(
						"../.cache/test-lab/install/node_modules/@graftland/plugin-remote/dist/bin.js",
					),
					packages: [
						{
							name: "@graftland/plugin-remote",
							dist: local("../.cache/runner"),
							exports: {
								"./bin": "./dist/bin.js",
								"./runner": "./dist/runner/index.js",
								"./watchdog": "./dist/watchdog.js",
								"./runner/supervisor": "./dist/runner/supervisor.js",
								"./runner/websocket": "./dist/runner/websocket.js",
								"./runner/auth/jwt": "./dist/runner/auth/jwt.js",
							},
						},
						{
							name: "@graftland/sample-remote-runner",
							dist: local("../.cache/worker"),
							exports: { "./contract": "./dist/contract.js" },
						},
					],
				})
				const { first, second, late } = yield* demo(environment)

				assert.equal(first.generation, 1)
				assert.equal(second.generation, 2)
				assert.notEqual(first.pid, second.pid)
				assert.notEqual(first.pid, process.pid)
				// Each host stop waited for the runner to confirm that its process exited.
				assert.throws(() => process.kill(first.pid, 0))
				assert.throws(() => process.kill(second.pid, 0))

				assert.isTrue(Result.isFailure(late))
				if (Result.isFailure(late)) {
					assert.equal(late.failure._tag, "StaleGeneration")
					if (late.failure._tag === "StaleGeneration")
						assert.equal(late.failure.latest, 2)
				}
				const fs = yield* FileSystem.FileSystem
				const ledger = yield* fs.readFileString(environment.LEDGER_FILE)
				assert.include(ledger, "INV-2")
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.merge(NodeServices.layer, crypto)),
			),
	)
})
