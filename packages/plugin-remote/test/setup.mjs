import { copyFile, mkdir } from "node:fs/promises"

import { build } from "tsdown"

export default async function setup() {
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
