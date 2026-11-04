import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: [
		"src/index.ts",
		"src/Commands.ts",
		"src/Application.ts",
		"src/bin.ts",
		"src/internal/configSchema.ts",
	],
})
