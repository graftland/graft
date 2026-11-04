import { defineConfig } from "tsdown"

export default defineConfig({
	entry: ["src/forecastContract.ts", "src/plugins/forecasts.ts"],
	root: "src",
	format: "esm",
	platform: "node",
	fixedExtension: false,
	dts: false,
	deps: { neverBundle: true },
})
