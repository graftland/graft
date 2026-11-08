#!/usr/bin/env node
/**
 * Naming checks from design/architecture.md §2.4:
 * - an error class has the same name as its `_tag`;
 * - a core word is a bare public export name only where its meaning is defined
 *   (owners) or where an entry below gives the reason.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

/** architecture.md §2.2, written as export names. */
export const coreWords = [
	"Plugin",
	"Instance",
	"Service",
	"Contract",
	"Realm",
	"DeploymentGroup",
	"Unit",
	"Generation",
	"Placement",
	"Artifact",
	"Release",
	"Change",
	"Outcome",
	"Probe",
	"TrustPolicy",
]

/** `file:name` → why the bare core word is correct there. */
export const allowed = new Map([
	["packages/core/src/index.ts:Change", "Owner: the Change module"],
	["packages/core/src/index.ts:Plugin", "Owner: the Plugin module"],
	["packages/core/src/Plugin.ts:Plugin", "Owner: the plugin value type"],
	["packages/core/src/Change.ts:Outcome", "Owner: a Change's outcome"],
	[
		"packages/core/src/Change.ts:Placement",
		"Owner: the unit placement a Change requests",
	],
	["packages/core/src/Kernel.ts:Outcome", "Owner: same type as Change.Outcome"],
	[
		"packages/core/src/Kernel.ts:Placement",
		"Owner: same type as Change.Placement",
	],
	[
		"packages/core/src/Kernel.ts:Unit",
		"Owner: a unit as the kernel reports it",
	],
	[
		"packages/core/src/Kernel.ts:DeploymentGroup",
		"Owner: a deployment group as the kernel reports it",
	],
	[
		"packages/plugin-remote/src/index.ts:Artifact",
		"Owner: the Artifact module",
	],
	[
		"packages/plugin-remote/src/index.ts:Contract",
		"Owner: the Contract module",
	],
	[
		"packages/plugin-remote/src/Artifact.ts:Artifact",
		"Owner: a captured artifact",
	],
	[
		"packages/plugin-remote/src/Contract.ts:Contract",
		"Owner: a contract descriptor",
	],
	[
		"packages/plugin-remote/src/Contract.ts:Service",
		"An Effect service as it crosses units; same meaning as the core word",
	],
	["packages/plugin-release/src/Model.ts:Release", "Owner: the release record"],
	[
		"packages/plugin-release/src/Model.ts:Placement",
		"The placement a release declares for an entry; same meaning",
	],
	[
		"packages/core/src/Manifest.ts:Placement",
		"The placements a package declares for an entry; same meaning",
	],
	[
		"packages/core/src/Manifest.ts:Service",
		"Describes an Effect service in a package manifest; same meaning",
	],
	[
		"packages/plugin-remote/src/Policy.ts:Service",
		"The Effect service that carries operator policy",
	],
])

const sources = (directory) =>
	readdirSync(directory).flatMap((name) => {
		const path = join(directory, name)
		if (name === "node_modules" || name === "dist" || name.startsWith("."))
			return []
		if (statSync(path).isDirectory()) return sources(path)
		return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [path] : []
	})

const packages = readdirSync(join(root, "packages")).flatMap((name) => {
	const src = join(root, "packages", name, "src")
	try {
		return statSync(src).isDirectory() ? [src] : []
	} catch {
		return []
	}
})
const files = packages.flatMap(sources)

const errorClass =
	/class\s+(\w+)\s+extends\s+(?:Schema\.TaggedErrorClass|Schema\.TaggedError|Data\.TaggedError)\b[^(]*(?:\([^)]*\))?\s*\(\s*"([^"]+)"/g
/** Error classes in `text` whose name differs from their `_tag`, as `[name, tag]`. */
export const errorMismatches = (text) =>
	Array.from(text.matchAll(errorClass))
		.filter((m) => m[1] !== m[2])
		.map((m) => [m[1], m[2]])
/** Names a module exports, including `export *` namespaces and re-exports. */
export const exportNames = (text) => {
	const names = []
	for (const m of text.matchAll(
		/^export\s+(?:declare\s+)?(?:const|let|class|interface|type|function|enum)\s+(\w+)/gm,
	))
		names.push(m[1])
	for (const m of text.matchAll(/^export\s+\*\s+as\s+(\w+)/gm)) names.push(m[1])
	for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm))
		for (const part of m[1].split(",")) {
			const name = part
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)
				.pop()
				?.trim()
			if (name) names.push(name)
		}
	return names
}

export const check = () => {
	const problems = []
	const used = new Set()
	for (const file of files) {
		const text = readFileSync(file, "utf8")
		const path = relative(root, file)
		for (const [name, tag] of errorMismatches(text))
			problems.push(`${path}: error class ${name} has the tag "${tag}"`)
		if (path.includes("/internal/")) continue
		for (const name of new Set(exportNames(text))) {
			if (!coreWords.includes(name)) continue
			const key = `${path}:${name}`
			if (allowed.has(key)) used.add(key)
			else
				problems.push(
					`${path}: exports the core word ${name}; use a qualified name or add an allowed entry with its reason`,
				)
		}
	}
	for (const key of allowed.keys())
		if (!used.has(key))
			problems.push(`Allowed entry ${key} no longer matches an export`)
	return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const problems = check()
	for (const problem of problems) console.error(problem)
	process.exit(problems.length === 0 ? 0 : 1)
}
