import { defineConfig } from "tsdown"

import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	entry: [
		"src/index.ts",
		"src/Config.ts",
		"src/HttpApis.ts",
		"src/scalar.ts",
		"src/swagger.ts",
		"src/schema.ts",
	],
})
