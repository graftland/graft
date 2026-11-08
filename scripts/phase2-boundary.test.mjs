import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { assert, it } from "vitest"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const text = (file) => readFileSync(resolve(root, file), "utf8")
const resolveImport = (file, specifier) => {
	if (specifier.startsWith(".")) {
		const path = resolve(root, dirname(file), specifier)
		return [path, path + ".ts", resolve(path, "index.ts")].find(existsSync)
	}
	if (specifier.startsWith("@graftland/graft/"))
		return resolve(
			root,
			"packages/core/src",
			specifier.slice("@graftland/graft/".length) + ".ts",
		)
}
const graph = (pending, seen = new Set()) => {
	if (pending.length === 0) return seen
	const [file, ...rest] = pending
	if (seen.has(file)) return graph(rest, seen)
	seen.add(file)
	const source = readFileSync(file, "utf8")
	const next = [
		...source.matchAll(
			/^(?:import|export)(?!\s+type\b)[^;]*?from\s*["']([^"']+)["']/gm,
		),
	].flatMap(
		(match) => resolveImport(file.slice(root.length + 1), match[1]) ?? [],
	)
	return graph([...rest, ...next], seen)
}
it("keeps the fixed kernel runtime graph outside contract and embedded plugin modules", () => {
	const visited = graph([
		resolve(root, "packages/plugin-remote/src/internal/kernelMain.ts"),
	])
	for (const file of visited) {
		assert.notMatch(
			file,
			/\/(?:Contract|Plugin|Graft|Fork|Transition|Manifest|nativeUnit|unitNetwork|unitRouter)\.ts$/,
		)
		assert.notMatch(file, /\/samples\//)
		assert.notMatch(readFileSync(file, "utf8"), /\bimport\s*\(/)
	}
	assert.isAbove(visited.size, 15)
})
it("imports fixed native and kernel executables without starting work", () => {
	const paths = ["kernelMain", "nativeUnitMain", "publicationMain"].map(
		(name) =>
			new URL(
				"../packages/plugin-remote/dist/internal/" + name + ".js",
				import.meta.url,
			).href,
	)
	const output = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			"await Promise.all(" +
				JSON.stringify(paths) +
				".map(path=>import(path))); console.log('inert')",
		],
		{ cwd: root, encoding: "utf8", timeout: 10000 },
	)
	assert.equal(output.trim(), "inert")
})
it("ships a runnable public gateway sample and keeps packed builds inside the worktree", () => {
	const exports = JSON.parse(
		text("packages/plugin-remote/package.json"),
	).exports
	assert.isDefined(exports["./kernel"])
	assert.isUndefined(exports["./internal/kernel"])
	const source = text("samples/integration-gateway/src/main.mjs")
	assert.include(source, "Control.connect")
	assert.include(source, "Artifact.capture")
	assert.notInclude(source, "/internal/")
	const fixture = text("scripts/consumerFixture.mjs")
	assert.notInclude(fixture, 'from "node:os"')
	assert.include(fixture, ".cache/packed-consumers")
	assert.isTrue(existsSync(resolve(root, "scripts/packed-gateway.mjs")))
	for (const name of ["README.md", "README.zh-CN.md", "README.zh-TW.md"])
		assert.isTrue(
			existsSync(resolve(root, "samples/integration-gateway", name)),
		)
})
it("maps every original Phase 1 test and review regression to auditable disposition evidence", () => {
	const inventory = JSON.parse(text("design/phase-2-test-disposition.json"))
	const laterManifests = text("design/phase-4-deletion-manifest.md")
	assert.equal(inventory.baseline, "aa36477")
	assert.isAtLeast(inventory.cases.length, 742)
	assert.isAtLeast(inventory.reviews.length, 50)
	assert.equal(
		new Set(inventory.cases.map((c) => c.file + "::" + c.title)).size,
		inventory.cases.length,
	)
	for (const c of [...inventory.cases, ...inventory.reviews]) {
		assert.include(["Retained", "Replaced", "Deleted", "Deferred"], c.status)
		assert.isNotEmpty(c.reason)
		assert.isNotEmpty(c.evidence)
		for (const evidence of c.evidence) {
			// Later phases may delete evidence; each deletion is recorded in a later manifest.
			assert.isTrue(
				existsSync(resolve(root, evidence.file)) ||
					laterManifests.includes("`" + evidence.file + "`"),
				evidence.file,
			)
			assert.isNotEmpty(evidence.test)
		}
	}
})

it("removes obsolete decision engines, host executors and duplicate model sources", () => {
	for (const path of [
		"packages/core/src/internal/changeAdmission.ts",
		"packages/core/src/internal/changeCoordinator.ts",
		"packages/core/src/internal/changeExecution.ts",
		"packages/core/src/internal/changePreparation.ts",
		"packages/core/src/internal/changeSettlement.ts",
		"packages/core/src/internal/changeTable.ts",
		"packages/core/src/internal/terminalSettlement.ts",
		"packages/core/src/internal/transition.ts",
		"packages/core/src/internal/ownedExecution.ts",
		"packages/core/src/internal/asyncClose.ts",
		"packages/core/test/change-model/model.ts",
		"packages/core/test/change-model/adapter.ts",
		"packages/core/test/change-driver.ts",
		"packages/plugin-remote/src/internal/transition.ts",
		"packages/plugin-remote/src/internal/execution.ts",
		"packages/plugin-remote/src/internal/entry.ts",
		"packages/plugin-remote/src/host/index.ts",
	])
		assert.isFalse(existsSync(resolve(root, path)), path)
})
