import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { changelogEntries, releaseNotes } from "./release-notes.mjs"

const changelog = `# @graftland/graft

## 0.7.0

### Minor Changes

- Future feature.

## 0.6.0

### Minor Changes

- [#42](https://github.com/graftland/graft/pull/42) [\`abcdef\`](https://github.com/graftland/graft/commit/abcdef) Thanks [@author](https://github.com/author)! - **Breaking:** Replace plugins through Changes.

  Keep the gateway running while a downstream plugin changes.

  - Report the actual outcome.
  - Keep the failure cause.

### Patch Changes

- Updated dependencies
  - @graftland/loader@0.6.0

## 0.5.0

### Patch Changes

- Previous fix.
`

test("only the exact requested version is included, with multiline entries intact", () => {
	const entries = changelogEntries(changelog.replaceAll("\n", "\r\n"), "0.6.0")
	assert.equal(entries.length, 2)
	assert.equal(entries[0].category, "Minor")
	assert.match(entries[0].text, /\*\*Breaking:\*\*/)
	assert.match(entries[0].text, /\n  - Keep the failure cause\./)
	assert.equal(
		entries[1].text,
		"- Updated dependencies\n  - @graftland/loader@0.6.0",
	)
	assert.doesNotMatch(JSON.stringify(entries), /Future feature|Previous fix/)
})

test("prerelease sections do not match the stable section or another prerelease", () => {
	const text = changelog.replaceAll("0.6.0", "0.6.0-beta.1")
	assert.equal(changelogEntries(text, "0.6.0-beta.1").length, 2)
	assert.throws(
		() => changelogEntries(text, "0.6.0"),
		/Missing changelog section/,
	)
	assert.throws(
		() => changelogEntries(text, "0.6.0-beta.2"),
		/Missing changelog section/,
	)
})

test("missing, empty, and unexpected changelog sections fail clearly", () => {
	assert.throws(
		() => changelogEntries(changelog, "0.8.0"),
		/Missing changelog section/,
	)
	assert.throws(
		() => changelogEntries("## 0.6.0\n\n### Patch Changes\n", "0.6.0"),
		/Empty changelog section/,
	)
	assert.throws(
		() => changelogEntries("## 0.6.0\nUnexpected text", "0.6.0"),
		/Unexpected changelog content/,
	)
	assert.throws(
		() => changelogEntries("## 0.6.0\n- Unclassified", "0.6.0"),
		/Missing change category/,
	)
})

function workspace(t) {
	const root = mkdtempSync(join(tmpdir(), "graft-release-notes-"))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	const add = (directory, manifest, notes) => {
		const path = join(root, "packages", directory)
		mkdirSync(path, { recursive: true })
		writeFileSync(join(path, "package.json"), JSON.stringify(manifest))
		if (notes !== undefined) writeFileSync(join(path, "CHANGELOG.md"), notes)
	}
	add("core", { name: "@graftland/graft", version: "0.6.0" }, changelog)
	add(
		"loader",
		{ name: "@graftland/loader", version: "0.6.0" },
		changelog.replace(/### Patch Changes[\s\S]*$/, ""),
	)
	add("docs", { name: "@graftland/docs", version: "0.0.0", private: true })
	return { root, add }
}

test("combined notes deduplicate shared entries and list public packages", (t) => {
	const { root, add } = workspace(t)
	add(
		"cli",
		{ name: "@graftland/cli", version: "0.6.0" },
		"## 0.6.0\n\n### Major Changes\n\n- **Breaking:** Run plugins in units.\n",
	)
	const notes = releaseNotes(root, "0.6.0")
	assert.equal(notes.match(/Replace plugins through Changes/g)?.length, 1)
	assert.match(
		notes,
		/Packages: \`@graftland\/graft\`, \`@graftland\/loader\`\./,
	)
	assert.match(notes, /Packages: \`@graftland\/graft\`\./)
	for (const name of ["cli", "graft", "loader"])
		assert.match(notes, new RegExp(`@graftland/${name}@0\\.6\\.0`))
	assert.doesNotMatch(notes, /@graftland\/docs|Future feature|Previous fix/)
	assert.ok(
		notes.indexOf("## Major Changes") < notes.indexOf("## Minor Changes"),
	)
	assert.ok(
		notes.indexOf("## Minor Changes") < notes.indexOf("## Patch Changes"),
	)
})

test("a public package with a missing changelog, missing section or wrong version stops generation", (t) => {
	const { root, add } = workspace(t)
	add("cli", { name: "@graftland/cli", version: "0.6.0" })
	assert.throws(() => releaseNotes(root, "0.6.0"), /ENOENT.*CHANGELOG\.md/)
	add("cli", { name: "@graftland/cli", version: "0.6.0" }, "## 0.5.0\n")
	assert.throws(() => releaseNotes(root, "0.6.0"), /Missing changelog section/)
	add("cli", { name: "@graftland/cli", version: "0.5.0" }, changelog)
	assert.throws(
		() => releaseNotes(root, "0.6.0"),
		/@graftland\/cli has version 0\.5\.0, expected 0\.6\.0/,
	)
})

test("the command writes combined Markdown notes without changing the changelogs", (t) => {
	const { root } = workspace(t)
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("./release-notes.mjs", import.meta.url)),
			"0.6.0",
			root,
		],
		{ encoding: "utf8" },
	)
	assert.equal(result.status, 0, result.stderr)
	assert.equal(result.stdout, releaseNotes(root, "0.6.0"))
	assert.equal(
		readFileSync(join(root, "packages/core/CHANGELOG.md"), "utf8"),
		changelog,
	)
})
