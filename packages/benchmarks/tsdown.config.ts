import { defineConfig } from "tsdown"

export default defineConfig({
	entry: ["src/*.ts"],
	format: "esm",
	platform: "node",
	fixedExtension: false,
	unbundle: true,
	deps: { neverBundle: true },
	dts: false,
})
