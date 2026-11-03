import type { UserConfig } from "tsdown"

export default {
	entry: ["src/index.ts"],
	format: "esm",
	platform: "node",
	fixedExtension: false,
	target: "esnext",
	unbundle: true,
	sourcemap: true,
	dts: { sourcemap: true },
	deps: { neverBundle: true },
	exports: { devExports: "source", bin: false },
} satisfies UserConfig
