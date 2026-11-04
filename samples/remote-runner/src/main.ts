import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { fileURLToPath } from "node:url"
import { demo } from "./host.ts"
import * as Lab from "./lab.ts"

const local = (relative: string) =>
	fileURLToPath(new URL(relative, import.meta.url))

NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			const environment = yield* Lab.start({
				directory: local("../.cache/lab"),
				certificates: local("../scripts/certificates.sh"),
				packages: [
					{
						name: "@graftland/remote",
						dist: fileURLToPath(
							new URL(".", import.meta.resolve("@graftland/remote")),
						),
						exports: {
							".": "./dist/index.js",
							"./bin": "./dist/bin.js",
							"./watchdog": "./dist/watchdog.js",
						},
					},
					{
						name: "@graftland/sample-remote-runner",
						dist: local("."),
						exports: { "./contract": "./dist/contract.js" },
					},
				],
			})
			yield* Console.log(`Runner listening on port ${environment.RUNNER_PORT}`)
			yield* demo(environment)
		}),
	).pipe(Effect.provide(NodeServices.layer)),
)
