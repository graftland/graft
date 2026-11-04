import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: [
		"src/index.ts",
		"src/Graft.ts",
		"src/Plugin.ts",
		"src/Event.ts",
		"src/Fork.ts",
		"src/Release.ts",
	],
})
