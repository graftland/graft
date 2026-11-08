import { defineConfig } from "tsdown"

import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	entry: [
		"src/index.ts",
		"src/Commands.ts",
		"src/Application.ts",
		"src/bin.ts",
		"src/Environment.ts",
		"src/internal/configSchema.ts",
	],
})
