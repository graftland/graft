import { Effect } from "effect"
import { assert, it } from "@effect/vitest"

import { program } from "../src/program.ts"
import { runWithLogs } from "./support.ts"

it.live("keeps each tenant's notes separate while sharing the layers", () =>
	Effect.gen(function* () {
		const [, output] = yield* runWithLogs(program)
		assert.deepStrictEqual(output, [
			'Opening notes for "acorn"',
			'Opening notes for "northstar"',
			'Saving "launch checklist" for "acorn"',
			'Reading notes {"texts":["launch checklist"]}',
			"The reader stopped",
			'Closing notes for "acorn"',
			"Acorn left; Northstar still has its own notes",
			'Saving "launch checklist" for "northstar"',
			'Reading notes {"texts":["launch checklist"]}',
			"The reader stopped",
			'Closing notes for "northstar"',
		])
	}),
)
