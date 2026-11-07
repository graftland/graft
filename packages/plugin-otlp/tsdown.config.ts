import { defineConfig } from "tsdown"

import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	entry: [
		"src/index.ts",
		"src/Config.ts",
		"src/schema.ts",
		"src/Exporter.ts",
		"src/http.ts",
		"src/Testing.ts",
	],
})
