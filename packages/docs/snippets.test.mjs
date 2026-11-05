import assert from "node:assert/strict"
import { test } from "node:test"

import { check, englishPages, fences, mismatches } from "./snippets.mjs"

test("Chinese pages carry the English code blocks unchanged", () => {
	assert.deepEqual(englishPages().flatMap(mismatches), [])
})

test("every TypeScript code block typechecks", () => {
	const result = check()
	assert.ok(result.files > 0, "found no code blocks")
	assert.equal(result.status, 0, result.output)
})

test("fences reads tagged TypeScript blocks only", () => {
	const blocks = fences(
		[
			'```ts title="a.ts"',
			"export const a = 1",
			"```",
			"```yaml",
			"a: 1",
			"```",
			"\t```ts import.meta.vitest",
			"\tconst b = 2",
			"\t```",
		].join("\n"),
	)
	assert.deepEqual(
		blocks.map(({ title, indent, body }) => ({ title, indent, body })),
		[
			{ title: "a.ts", indent: "", body: ["export const a = 1"] },
			{ title: undefined, indent: "\t", body: ["\tconst b = 2"] },
		],
	)
})
