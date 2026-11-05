import assert from "node:assert/strict"
import { test } from "node:test"

import { createTypes } from "./hover-types.mjs"
import { modules } from "./snippets.mjs"

const types = createTypes()
const [clock, uses] = modules("services.md")

const named = (found, lines, text) => {
	const name = found.find(
		(entry) => lines[entry.line].slice(entry.start, entry.end) === text,
	)
	assert.ok(name, `no type for ${text}`)
	return name
}

test("names in a code block get their type", () => {
	const found = types.lookup("services.md", clock.body)
	const name = named(found, clock.body.split("\n"), "Clock")
	assert.match(name.type, /^class Clock/)
})

test("a translated page uses the English page's types", () => {
	assert.deepEqual(
		types.lookup("zh-tw/services.md", uses.body),
		types.lookup("services.md", uses.body),
	)
})

test("columns follow tabs expanded to spaces", () => {
	const code = uses.body.replaceAll("\t", "  ")
	const found = types.lookup("services.md", code)
	assert.ok(found.length > 0)
	const lines = code.split("\n")
	for (const entry of found) {
		assert.match(lines[entry.line].slice(entry.start, entry.end), /^#?\w+$/)
	}
})

test("a block that is not on the page gets no types", () => {
	assert.deepEqual(types.lookup("services.md", "const a = 1"), [])
})
