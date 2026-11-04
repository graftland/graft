import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { declarationProject, publicPackages } from "./public-api.mjs"

export default function setup() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
	// Regenerate declarations before inspecting them, even when pnpm test runs without a preceding build.
	execFileSync(
		"pnpm",
		[
			"exec",
			"tsc",
			"-b",
			...publicPackages(root).map(({ directory }) => directory),
		],
		{ cwd: root, stdio: "inherit" },
	)
	const { config, entries } = declarationProject(root)
	const consumer = resolve(root, ".cache/public-api/consumer.json")
	writeFileSync(
		consumer,
		JSON.stringify({
			extends: resolve(root, "scripts/fixtures/public-api/tsconfig.json"),
			compilerOptions: {
				paths: JSON.parse(readFileSync(config, "utf8")).compilerOptions.paths,
			},
		}),
	)
	execFileSync("pnpm", ["exec", "tsc", "-p", consumer], {
		cwd: root,
		stdio: "inherit",
	})
	if (entries.length === 0)
		throw new Error("No public declaration entries were inspected")
}
