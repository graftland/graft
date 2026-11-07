import { defineConfig } from "tsdown"

import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	entry: [
		"src/index.ts",
		"src/Authorization.ts",
		"src/oauth.ts",
		"src/oauth/jwt.ts",
		"src/router.ts",
		"src/Config.ts",
		"src/Http.ts",
		"src/schema.ts",
		"src/Testing.ts",
	],
})
