import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { coreWords } from "../../scripts/check-names.mjs"

/** How each export name is written as a word in the docs. */
const written = (word) =>
	({ DeploymentGroup: "Deployment group", TrustPolicy: "Trust policy" })[
		word
	] ?? word

for (const [language, heading] of [
	["", "## Core words"],
	["zh-cn/", "## 核心词"],
	["zh-tw/", "## 核心詞"],
])
	test(`defines every core word in ${language || "en/"}concepts.md`, () => {
		const page = readFileSync(
			new URL(`./content/docs/${language}concepts.md`, import.meta.url),
			"utf8",
		)
		const start = page.indexOf(heading)
		assert.notEqual(start, -1, `${heading} is missing`)
		const section = page.slice(start, page.indexOf("\n## ", start + 1))
		const defined = Array.from(
			section.matchAll(/^\| \*\*([^*]+)\*\*/gm),
			(m) => m[1],
		)
		assert.deepEqual(defined, coreWords.map(written))
	})
