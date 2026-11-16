import { Effect } from "effect"
import { assert, it } from "@effect/vitest"

import { program } from "../src/program.ts"
import { runScopedWithLogs } from "./support.ts"

const interesting = (line: string) =>
	line === "The remote service is gone" ||
	line === "The remote service is available" ||
	line.startsWith("Before the drop") ||
	line === "The connection dropped and the remote service was withdrawn" ||
	line === "The connection is back and the remote service is published" ||
	line.startsWith("After reconnecting")

it.live(
	"withdraws the remote service on a drop and restores it on reconnect",
	() =>
		Effect.gen(function* () {
			const [, output] = yield* runScopedWithLogs(program)
			assert.deepStrictEqual(output.filter(interesting), [
				"The remote service is gone",
				"The remote service is available",
				"Before the drop, the book costs 12",
				"The remote service is gone",
				"The connection dropped and the remote service was withdrawn",
				"The remote service is available",
				"The connection is back and the remote service is published",
				"After reconnecting, the book costs 12",
			])
		}),
)
