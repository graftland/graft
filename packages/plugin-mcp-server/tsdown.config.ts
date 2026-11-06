import { defineConfig } from "tsdown"

import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	entry: [
		"src/index.ts",
		"src/stdio.ts",
		"src/http.ts",
		"src/Config.ts",
		"src/Server.ts",
		"src/Catalog.ts",
		"src/Tools.ts",
		"src/Resources.ts",
		"src/Prompts.ts",
		"src/Middleware.ts",
		"src/Extensions.ts",
		"src/Errors.ts",
		"src/Testing.ts",
		"src/schema.ts",
	],
})
