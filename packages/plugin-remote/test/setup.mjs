import { spawnSync } from "node:child_process"
import { copyFile, cp, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "tsdown"

export default async function setup(project) {
	const nativeAddon = new URL("../.cache/native-addon/", import.meta.url)
	let compiler
	for (const command of ["cc", "gcc", "clang"]) {
		const check = spawnSync(command, ["--version"], { encoding: "utf8" })
		if (check.error?.code === "ENOENT") continue
		if (check.error) throw check.error
		if (check.status !== 0)
			throw new Error(`${command} failed: ${check.stderr}`)
		compiler = command
		break
	}
	project.provide(
		"nativeAddonSkipReason",
		compiler ? "" : "No C compiler found (tried cc, gcc and clang)",
	)
	if (compiler) {
		await cp(
			new URL("./fixtures/native-addon/", import.meta.url),
			nativeAddon,
			{ recursive: true },
		)
		const compiled = spawnSync(
			compiler,
			[
				"-shared",
				"-fPIC",
				...(process.platform === "darwin"
					? ["-undefined", "dynamic_lookup"]
					: []),
				"-I",
				join(dirname(process.execPath), "..", "include", "node"),
				fileURLToPath(new URL("addon.c", nativeAddon)),
				"-o",
				fileURLToPath(new URL("addon.node", nativeAddon)),
			],
			{ encoding: "utf8" },
		)
		if (compiled.error) throw compiled.error
		if (compiled.status !== 0)
			throw new Error(`Native addon compilation failed: ${compiled.stderr}`)
	}
	await build({
		config: false,
		entry: [
			"index",
			"Units",
			"Control",
			"Contract",
			"Artifact",
			"internal/nativeUnit",
			"internal/nativeUnitMain",
			"internal/kernelMain",
			"internal/jsonLines",
			"internal/publicationMain",
		].map((name) => new URL(`../src/${name}.ts`, import.meta.url).pathname),
		outDir: new URL("../dist", import.meta.url).pathname,
		root: new URL("../src", import.meta.url).pathname,
		format: "esm",
		fixedExtension: false,
		platform: "node",
		dts: false,
		clean: false,
		deps: {
			alwaysBundle: [/^@graftland\/(?:graft|loader|cli)(?:\/|$)/],
			neverBundle: [/^effect(?:\/|$)/, /^@effect\//],
		},
		inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
	})
	// The sandboxed unit entry bundles every dependency, as the package build does.
	await build({
		config: false,
		entry: {
			"sandbox/unit": new URL(
				"../src/internal/nativeUnitMain.ts",
				import.meta.url,
			).pathname,
		},
		outDir: new URL("../dist", import.meta.url).pathname,
		format: "esm",
		fixedExtension: false,
		platform: "node",
		target: "node22",
		dts: false,
		clean: false,
		deps: { alwaysBundle: [/^(?!node:)/] },
		inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
	})
	// A self-contained hostile plugin: inside the sandbox only its own directory exists.
	const canary = new URL("../.cache/sandbox-canary/", import.meta.url)
	await mkdir(canary, { recursive: true })
	await build({
		config: false,
		entry: {
			canary: new URL("./fixtures/sandbox/canary.ts", import.meta.url).pathname,
		},
		outDir: canary.pathname,
		format: "esm",
		fixedExtension: false,
		platform: "node",
		target: "node22",
		dts: false,
		clean: false,
		deps: { alwaysBundle: [/^(?!node:)/] },
		inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
	})
	await copyFile(
		new URL("./fixtures/sandbox/package.json", import.meta.url),
		new URL("package.json", canary),
	)
}
