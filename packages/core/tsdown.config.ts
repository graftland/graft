import { defineConfig } from "tsdown"

import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	entry: [
		"src/index.ts",
		"src/Change.ts",
		"src/Graft.ts",
		"src/Plugin.ts",
		"src/Event.ts",
		"src/Fork.ts",
		"src/Release.ts",
		"src/Transition.ts",
		"src/Trust.ts",
		"src/Manifest.ts",
	],
})
