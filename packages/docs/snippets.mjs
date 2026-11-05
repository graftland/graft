// Extracts the TypeScript code blocks of the guide pages, so they can be
// typechecked and kept identical across languages.
//
//   node snippets.mjs check [page.md ...]   typecheck the English code blocks
//   node snippets.mjs sync [page.md ...]    copy them into the Chinese pages
//
// Pages are relative to `content/docs`, such as `services.md`; without any,
// every page is used.

import { spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

export const root = dirname(fileURLToPath(import.meta.url))
export const content = join(root, "content", "docs")
export const locales = ["zh-cn", "zh-tw"]

const opening = /^(\s*)(`{3,}|~{3,})(.*)$/

/** Whether a fence's info string marks TypeScript. */
const isTypeScript = (info) => /^(ts|typescript)(\s|$)/.test(info)

/** The TypeScript fences of a page, with their position in the text. */
export function fences(text) {
	const lines = text.split("\n")
	const found = []
	for (let index = 0; index < lines.length; index++) {
		const match = opening.exec(lines[index])
		if (!match) continue
		const [, indent, marker, info] = match
		const close = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`)
		let end = index + 1
		while (end < lines.length && !close.test(lines[end])) end++
		if (isTypeScript(info.trim())) {
			found.push({
				info: info.trim(),
				indent,
				start: index + 1,
				end,
				body: lines.slice(index + 1, end),
				title: /(?:^|\s)title="([^"]+)"/.exec(info)?.[1],
			})
		}
		index = end
	}
	return found
}

/** English guide pages, relative to `content/docs`. */
export function englishPages() {
	const walk = (directory) =>
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) {
				return locales.includes(relative(content, path)) ? [] : walk(path)
			}
			return /\.mdx?$/.test(entry.name) ? [relative(content, path)] : []
		})
	return walk(content).sort()
}

/** Code blocks of a Chinese page that differ from its English page. */
export function mismatches(page) {
	const english = fences(readFileSync(join(content, page), "utf8"))
	return locales.flatMap((locale) => {
		const translated = fences(readFileSync(join(content, locale, page), "utf8"))
		if (translated.length !== english.length) {
			return [
				`${locale}/${page}: ${translated.length} code blocks, English has ${english.length}`,
			]
		}
		return english.flatMap((block, index) =>
			block.info === translated[index].info &&
			block.body.join("\n") === translated[index].body.join("\n")
				? []
				: [
						`${locale}/${page}:${translated[index].start}: differs from the English code block at line ${english[index].start}`,
					],
		)
	})
}

/** Copies the English code blocks into the Chinese pages, block by block. */
export function sync(pages = englishPages()) {
	for (const page of pages) {
		const english = fences(readFileSync(join(content, page), "utf8"))
		for (const locale of locales) {
			const path = join(content, locale, page)
			const lines = readFileSync(path, "utf8").split("\n")
			const translated = fences(lines.join("\n"))
			if (translated.length !== english.length) {
				throw new Error(
					`${locale}/${page}: ${translated.length} code blocks, English has ${english.length}; fix by hand`,
				)
			}
			for (let index = translated.length - 1; index >= 0; index--) {
				const target = translated[index]
				const source = english[index]
				lines.splice(
					target.start - 1,
					target.end - target.start + 1,
					`${target.indent}\`\`\`${source.info}`,
					...source.body,
				)
			}
			writeFileSync(path, lines.join("\n"))
		}
	}
}

export const output = join(root, ".cache", "snippets")

/** Whether a code block is left out of the typecheck: `ts skip` shows code that is meant to be wrong. */
const skipped = (block) => /(^|\s)skip(\s|$)/.test(block.info)

const tsconfig = (files) =>
	JSON.stringify(
		{
			extends: "../../../../tsconfig.base.json",
			compilerOptions: {
				composite: false,
				incremental: false,
				declaration: false,
				declarationMap: false,
				emitDeclarationOnly: false,
				noEmit: true,
				allowImportingTsExtensions: true,
				customConditions: ["source"],
				// A code block shows one idea; the values it defines are for the reader.
				noUnusedLocals: false,
				noUnusedParameters: false,
			},
			files,
		},
		null,
		"\t",
	)

// Keys in examples name the example's app, such as "app/Clock"; the rule would
// expect a key derived from this cache path, which no reader sees.
const directives = "// @effect-diagnostics deterministicKeys:off\n"

// Test code provides its own layers at each test, as `tsconfig.base.json`
// allows for `**/test/**`: the blocks of the testing page, and any block that
// imports `@effect/vitest`.
const testPages = new Set(["best-practices/testing.md"])
const testDirectives = "// @effect-diagnostics strictEffectProvide:off\n"

const header = (page, body) =>
	testPages.has(page) || body.includes('from "@effect/vitest"')
		? `${directives}${testDirectives}`
		: directives

const writeIfChanged = (file, text) => {
	if (existsSync(file) && readFileSync(file, "utf8") === text) return
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, text)
}

/** Files under a folder, relative to it. */
const listFiles = (folder) =>
	existsSync(folder)
		? readdirSync(folder, { withFileTypes: true, recursive: true })
				.filter((entry) => entry.isFile())
				.map((entry) => relative(folder, join(entry.parentPath, entry.name)))
		: []

/**
 * Writes the English code blocks of the given pages to `.cache/snippets`, one
 * module each, and returns the files to typecheck. A block with
 * `title="clock.ts"` is written to that path within its page's folder, so
 * later blocks of the same page can import it as `./clock.ts`; the doctests
 * resolve such imports here too. Files are only rewritten when they change, so
 * several checks can run at once.
 */
export function write(pages = englishPages()) {
	const files = []
	for (const page of pages) {
		const folder = join(output, page.replace(/\.mdx?$/, ""))
		const written = new Set()
		for (const [index, block] of fences(
			readFileSync(join(content, page), "utf8"),
		).entries()) {
			const name =
				block.title ??
				`block-${String(index + 1).padStart(2, "0")}-line-${block.start}.ts`
			if (written.has(name))
				throw new Error(`${page}: two code blocks are titled ${name}`)
			written.add(name)
			const body = block.body
				.map((line) => line.slice(block.indent.length))
				.join("\n")
			writeIfChanged(join(folder, name), `${header(page, body)}${body}\n`)
			if (!skipped(block)) files.push(relative(output, join(folder, name)))
		}
		for (const stale of listFiles(folder)) {
			if (!written.has(stale)) rmSync(join(folder, stale))
		}
	}
	return files
}

/** Typechecks the code blocks of the given pages. */
export function check(pages = englishPages()) {
	const files = write(pages)
	const all = pages.length === englishPages().length
	const name = all
		? "tsconfig.json"
		: `tsconfig.${pages.map((page) => page.replace(/[\\/.]/g, "_")).join("+")}.json`
	writeIfChanged(join(output, name), tsconfig(files))
	const tsc = join(root, "..", "..", "node_modules", ".bin", "tsc")
	const result = spawnSync(
		tsc,
		["--project", join(output, name), "--pretty", "false"],
		{ cwd: output, encoding: "utf8" },
	)
	if (result.error) throw result.error
	return {
		files: files.length,
		status: result.status,
		output: `${result.stdout}${result.stderr}`,
	}
}

/**
 * Resolves a relative import in a doctest to the module written from a titled
 * code block of the same page.
 */
export function resolveTitled(source, importer) {
	if (!/^\.\.?\//.test(source) || importer === undefined) return undefined
	const file = importer.split("?")[0]
	if (!file.startsWith(content) || !/\.mdx?$/.test(file)) return undefined
	const page = relative(content, file).replace(/\.mdx?$/, "")
	const target = join(output, page, source)
	return existsSync(target) ? target : undefined
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, ...pages] = process.argv.slice(2)
	const selected = pages.length
		? pages.map((page) => relative(content, join(content, page)))
		: undefined
	if (command === "sync") {
		sync(selected)
	} else if (command === "check") {
		const result = check(selected)
		process.stdout.write(result.output)
		console.log(`Typechecked ${result.files} code blocks`)
		process.exitCode = result.status ?? 1
	} else {
		console.error(
			"Usage: node snippets.mjs check|sync [page.md ...]  (pages relative to content/docs)",
		)
		process.exitCode = 2
	}
}
