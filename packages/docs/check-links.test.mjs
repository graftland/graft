import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { checkLinks } from "./check-links.mjs"

function fixture(files, run) {
	const cache = fileURLToPath(new URL("./.cache/link-tests/", import.meta.url))
	mkdirSync(cache, { recursive: true })
	const directory = mkdtempSync(join(cache, "case-"))
	try {
		for (const [name, text] of Object.entries(files)) {
			const file = join(directory, name)
			mkdirSync(dirname(file), { recursive: true })
			writeFileSync(file, text)
		}
		run(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

const site = new URL("https://example.com/graft/")

test("resolves deployment bases, localized fallbacks, and encoded anchors", () =>
	fixture(
		{
			"index.html":
				'<a href="/graft/zh-cn/reference/">API</a><a href="https://elsewhere.example/missing">External</a>',
			"zh-cn/reference/index.html":
				'<a href="../../reference/#%E5%8F%82%E8%80%83">English</a>',
			"reference/index.html":
				'<h2 id="参考">Reference</h2><a href="#a&amp;b">Details</a><p id="a&amp;b"></p>',
		},
		(directory) => assert.equal(checkLinks(directory, site), 3),
	))

for (const [name, href, reason] of [
	["missing page", "/graft/missing/", "missing page"],
	["missing anchor", "#missing", "missing anchor"],
	["missing base", "/reference/", "escapes site base"],
]) {
	test(`rejects a ${name}`, () =>
		fixture({ "index.html": `<a href="${href}">Link</a>` }, (directory) =>
			assert.throws(() => checkLinks(directory, site), new RegExp(reason)),
		))
}
