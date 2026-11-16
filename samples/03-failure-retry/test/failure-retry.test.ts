import { Effect } from "effect"
import { assert, it } from "@effect/vitest"

import { program } from "../src/program.ts"
import { runWithLogs } from "./support.ts"

const interesting = (line: string) =>
	line.startsWith("Connecting") ||
	line === "The backend is not ready yet" ||
	line === "The mount is active" ||
	line === "Using the backend, ready: true" ||
	line === "Closing the backend"

it.live("retries the failed mount until it becomes active", () =>
	Effect.gen(function* () {
		const [, output] = yield* runWithLogs(program)
		assert.deepStrictEqual(output.filter(interesting), [
			"Connecting (attempt 1)",
			"The backend is not ready yet",
			"Connecting (attempt 2)",
			"The backend is not ready yet",
			"Connecting (attempt 3)",
			"The mount is active",
			"Using the backend, ready: true",
			"Closing the backend",
		])
	}),
)
