import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { API, SymbolFlags } from "typescript/unstable/sync"

import { publicEntries, publicPackages } from "./public-api.mjs"

/** Entries an application imports; internal subpaths exist only so runtimes can load them. */
export const referenceEntries = (root) =>
	publicEntries(root).filter((entry) => !entry.name.includes("/internal/"))

/** Cross-check TypeDoc's export inventory with the compiler used by the workspace. */
export function verifyReference(root) {
	const entries = referenceEntries(root)
	const reports = publicPackages(root).map(({ manifest }) => ({
		packageName: manifest.name,
		...JSON.parse(
			readFileSync(
				join(
					root,
					"packages/docs/.cache/reference",
					manifest.name.replace("@graftland/", "") + ".json",
				),
				"utf8",
			),
		),
	}))
	const invalid = reports.flatMap((report) =>
		(report.invalid ?? []).map(
			(warning) => `${report.packageName}: ${warning}`,
		),
	)
	if (invalid.length > 0)
		throw new Error(
			`TypeDoc validation failed. Export every type a public signature mentions:\n${invalid.join("\n")}`,
		)
	const coverage = reports.flatMap((report) => report.coverage)
	if (
		coverage.length !== entries.length ||
		new Set(coverage.map((entry) => entry.name)).size !== entries.length
	)
		throw new Error("Reference entry coverage does not match package exports")
	const config = join(root, "packages/docs/tsconfig.reference.json")
	const api = new API({ cwd: root })
	try {
		const snapshot = api.updateSnapshot({ openProjects: [config] })
		try {
			const project = snapshot.getProject(config)
			if (!project) throw new Error("Missing reference project")
			const { program, checker } = project
			for (const entry of entries) {
				const source = program.getSourceFile(
					resolve(entry.directory, entry.source),
				)
				if (!source) throw new Error(`Missing reference source: ${entry.name}`)
				const symbol = checker.getSymbolAtLocation(source)
				const exports = symbol
					? checker
							.getExportsOfModule(symbol)
							.filter((symbol) => {
								const resolved =
									symbol.flags & SymbolFlags.Alias
										? checker.getAliasedSymbol(symbol)
										: symbol
								return ![
									...symbol.getJsDocTags(checker),
									...resolved.getJsDocTags(checker),
								].some((tag) => tag.name === "internal")
							})
							.map((symbol) => symbol.name)
							.sort()
					: []
				const documented = [
					...new Set(
						coverage.find((record) => record.name === entry.name)?.exports ??
							[],
					),
				].sort()
				if (JSON.stringify(exports) !== JSON.stringify(documented))
					throw new Error(
						`Reference exports differ for ${entry.name}: expected ${exports.join(", ")}; documented ${documented.join(", ")}`,
					)
			}
		} finally {
			snapshot.dispose()
		}
	} finally {
		api.close()
	}
	writeFileSync(
		join(root, "packages/docs/.cache/reference/report.json"),
		JSON.stringify(
			{
				entries: coverage,
				undocumented: reports.map(({ packageName, undocumented }) => ({
					packageName,
					symbols: undocumented,
				})),
			},
			null,
			2,
		) + "\n",
	)
	return entries.length
}
