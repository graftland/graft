import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"
import { crypto } from "./credentials.ts"
import { demo } from "./host.ts"
import * as Lab from "./lab.ts"

const local = (relative: string) =>
	fileURLToPath(new URL(relative, import.meta.url))

NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			const environment = yield* Lab.start({
				directory: local("../.cache/lab"),
				runner: fileURLToPath(import.meta.resolve("@graftland/remote/bin")),
				packages: [
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
	).pipe(Effect.provide(Layer.merge(NodeServices.layer, crypto))),
)
