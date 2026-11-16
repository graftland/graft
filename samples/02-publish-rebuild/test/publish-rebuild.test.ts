import { Effect } from "effect"
import { assert, it } from "@effect/vitest"

import { program } from "../src/program.ts"
import { runWithLogs } from "./support.ts"

it.live("rebuilds the mount when the published value changes", () =>
	Effect.gen(function* () {
		const [, output] = yield* runWithLogs(program)
		assert.deepStrictEqual(output, [
			'Building the greeter with "Hello"',
			"Hello, world!",
			'Releasing the greeter for "Hello"',
			'Building the greeter with "Hi"',
			"Hi, again!",
			'Releasing the greeter for "Hi"',
		])
	}),
)
