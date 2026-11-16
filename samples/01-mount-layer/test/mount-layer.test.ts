import { Effect } from "effect"
import { assert, it } from "@effect/vitest"

import { program } from "../src/program.ts"
import { runWithLogs } from "./support.ts"

it.live("mounts the layer, uses the service, and releases it", () =>
	Effect.gen(function* () {
		const [, output] = yield* runWithLogs(program)
		assert.deepStrictEqual(output, [
			"Building the greeter",
			"Hello, world!",
			"Releasing the greeter",
		])
	}),
)
