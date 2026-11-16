import { Effect } from "effect"
import { assert, it } from "@effect/vitest"

import { program } from "../src/program.ts"
import { runScopedWithLogs } from "./support.ts"

it.live("calls the service over effect/rpc from another graph", () =>
	Effect.gen(function* () {
		const [, output] = yield* runScopedWithLogs(program)
		assert.deepStrictEqual(output, ["The book costs 12"])
	}),
)
