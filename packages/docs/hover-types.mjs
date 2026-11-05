// Shows the TypeScript type of each name in a code block when the reader
// hovers it. The types come from the same project that `snippets.mjs`
// typechecks, so they match what an editor shows for the example.

import { statSync } from "node:fs"
import { dirname, relative } from "node:path"

import {
	definePlugin,
	ExpressiveCodeAnnotation,
} from "@astrojs/starlight/expressive-code"
import ts from "typescript"

import { content, locales, modules, project, write } from "./snippets.mjs"

/**
 * A language service over the code blocks of every guide page. Pages are
 * rewritten before they are read, so `astro dev` picks up edits.
 */
export function createTypes() {
	const { path } = project()
	const config = ts.getParsedCommandLineOfConfigFile(
		path,
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
				throw new Error(
					ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
				)
			},
		},
	)
	const roots = new Set(config.fileNames)
	const version = (file) => {
		try {
			return String(statSync(file).mtimeMs)
		} catch {
			return "missing"
		}
	}
	const service = ts.createLanguageService(
		{
			getScriptFileNames: () => [...roots],
			getScriptVersion: version,
			getScriptSnapshot: (file) => {
				const text = ts.sys.readFile(file)
				return text === undefined
					? undefined
					: ts.ScriptSnapshot.fromString(text)
			},
			getCurrentDirectory: () => dirname(path),
			getCompilationSettings: () => config.options,
			getDefaultLibFileName: ts.getDefaultLibFilePath,
			fileExists: ts.sys.fileExists,
			readFile: ts.sys.readFile,
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			realpath: ts.sys.realpath,
		},
		ts.createDocumentRegistry(),
	)

	/**
	 * The names in a code block of a guide page and their quick info, by line
	 * and column of `code`. `page` is relative to `content/docs` and may be a
	 * translation; its code blocks are those of the English page. `code` may
	 * have its tabs expanded to spaces, as Expressive Code does.
	 */
	const lookup = (page, code) => {
		const english = page.replace(new RegExp(`^(${locales.join("|")})/`), "")
		write([english])
		const match = modules(english)
			.map((block) => ({ block, tab: tabWidth(block.body, code) }))
			.find(({ tab }) => tab !== undefined)
		if (match === undefined || match.block.skipped) return []
		const { block, tab } = match
		roots.add(block.file)
		const source = service.getProgram()?.getSourceFile(block.file)
		if (source === undefined) return []
		const offset = block.prefix.split("\n").length - 1
		const lines = block.body.split("\n")
		const column = (line, character) => {
			const tabs = lines[line].slice(0, character).split("\t").length - 1
			return character + tabs * (tab - 1)
		}
		const found = []
		const visit = (node) => {
			if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
				const start = node.getStart(source)
				const info = service.getQuickInfoAtPosition(block.file, start)
				const type = ts.displayPartsToString(info?.displayParts)
				const { line, character } = source.getLineAndCharacterOfPosition(start)
				if (type !== "" && line >= offset) {
					found.push({
						line: line - offset,
						start: column(line - offset, character),
						end: column(line - offset, character + node.getWidth(source)),
						type,
						docs: firstParagraph(ts.displayPartsToString(info?.documentation)),
					})
				}
			}
			ts.forEachChild(node, visit)
		}
		visit(source)
		return found
	}
	return { lookup }
}

/**
 * The number of spaces each tab of `body` became in `code`, with 1 for tabs
 * kept as they are, or `undefined` when `code` is not that block.
 */
const tabWidth = (body, code) => {
	const target = code.trimEnd()
	if (body.trimEnd() === target) return 1
	for (let width = 2; width <= 8; width++) {
		if (body.replaceAll("\t", " ".repeat(width)).trimEnd() === target)
			return width
	}
	return undefined
}

const firstParagraph = (text) => text.split(/\n\s*\n/)[0].trim()

class TypeAnnotation extends ExpressiveCodeAnnotation {
	name = "graft-type"
	constructor({ type, docs, ...options }) {
		super(options)
		this.type = type
		this.docs = docs
	}
	render({ nodesToTransform }) {
		return nodesToTransform.map((node) => ({
			type: "element",
			tagName: "span",
			properties: {
				className: ["graft-type"],
				dataType: this.type,
				...(this.docs === "" ? {} : { dataDocs: this.docs }),
			},
			children: [node],
		}))
	}
}

/** Shows a tooltip for the hovered or tapped name. Runs in the page. */
const tooltip = `
const tip = document.createElement("div")
tip.className = "graft-type-tip"
tip.setAttribute("role", "tooltip")
tip.hidden = true
let current
const show = (target) => {
	if (current === target) return
	current = target
	tip.replaceChildren()
	const code = document.createElement("pre")
	code.textContent = target.dataset.type
	tip.append(code)
	if (target.dataset.docs) {
		const docs = document.createElement("p")
		docs.textContent = target.dataset.docs
		tip.append(docs)
	}
	if (!tip.isConnected) document.body.append(tip)
	tip.hidden = false
	// Measure at full width before placing it next to the name.
	tip.style.left = "0px"
	tip.style.top = "0px"
	const box = target.getBoundingClientRect()
	const width = tip.offsetWidth
	const height = tip.offsetHeight
	const left = Math.max(8, Math.min(box.left, innerWidth - width - 8))
	const below = box.bottom + 4
	const top = below + height > innerHeight - 8 && box.top - height - 4 > 8
		? box.top - height - 4
		: below
	tip.style.left = left + "px"
	tip.style.top = top + "px"
}
const hide = () => {
	current = undefined
	tip.hidden = true
}
const nameAt = (event) => event.target instanceof Element ? event.target.closest(".graft-type") : null
document.addEventListener("pointerover", (event) => {
	if (event.pointerType !== "mouse") return
	const target = nameAt(event)
	if (target) show(target)
	else if (!(event.target instanceof Node && tip.contains(event.target))) hide()
})
document.addEventListener("click", (event) => {
	const target = nameAt(event)
	if (target) show(target)
	else if (!(event.target instanceof Node && tip.contains(event.target))) hide()
})
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") hide()
})
addEventListener("scroll", hide, { passive: true })
`

/** An Expressive Code plugin that adds hover types to the TypeScript blocks of the guide pages. */
export function hoverTypes() {
	let types
	return definePlugin({
		name: "graft-hover-types",
		jsModules: [tooltip],
		hooks: {
			annotateCode: ({ codeBlock }) => {
				const file = codeBlock.parentDocument?.sourceFilePath
				if (file === undefined || !/^(ts|typescript)$/.test(codeBlock.language))
					return
				const page = relative(content, file)
				if (page.startsWith("..") || !/\.mdx?$/.test(page)) return
				types ??= createTypes()
				const lines = codeBlock.getLines()
				for (const name of types.lookup(page, codeBlock.code)) {
					lines[name.line]?.addAnnotation(
						new TypeAnnotation({
							inlineRange: { columnStart: name.start, columnEnd: name.end },
							type: name.type,
							docs: name.docs,
						}),
					)
				}
			},
		},
	})
}
