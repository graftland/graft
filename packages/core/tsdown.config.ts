import { defineConfig } from "tsdown"

import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	entry: [
		"src/index.ts",
		"src/rpc/index.ts",
		"src/node/index.ts",
		"src/testing/index.ts",
	],
})
