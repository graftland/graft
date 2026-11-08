import { defineConfig } from "tsdown"

export default defineConfig({
	entry: ["src/**/*.ts"],
	format: "esm",
	fixedExtension: false,
	platform: "node",
	unbundle: true,
	deps: { neverBundle: true },
	dts: false,
	sourcemap: true,
})
