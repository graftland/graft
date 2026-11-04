import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Result } from "effect"
import process from "node:process"
import { fileURLToPath } from "node:url"
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
					certificates: local("../scripts/certificates.sh"),
					packages: [
						{
							name: "@graftland/remote",
							dist: local("../.cache/runner"),
							exports: {
								"./bin": "./dist/bin.js",
								"./watchdog": "./dist/watchdog.js",
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
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
