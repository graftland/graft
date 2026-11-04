import { defineConfig } from "tsdown"

export default defineConfig({
	entry: ["src/contract.ts", "src/greeter.ts"],
	format: "esm",
	platform: "node",
	fixedExtension: false,
	dts: false,
	deps: { neverBundle: true },
})
