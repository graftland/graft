import { defineConfig } from "tsdown"

export default defineConfig({
	entry: [
		"src/main.ts",
		"src/issue-token.ts",
		"src/contract.ts",
		"src/worker.ts",
	],
	format: "esm",
	platform: "node",
	fixedExtension: false,
	dts: false,
	deps: { neverBundle: true },
})
