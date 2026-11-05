import { defineConfig } from "tsdown"

import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	entry: ["src/index.ts", "src/Command.ts", "src/bin.ts"],
})
