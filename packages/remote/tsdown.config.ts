import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	exports: {
		...config.exports,
		// Executables run in plain Node, even when the host uses source conditions.
		customExports: {
			"./bin": "./dist/bin.js",
			"./watchdog": "./dist/watchdog.js",
		},
	},
	entry: ["src/index.ts", "src/Runner.ts", "src/bin.ts", "src/watchdog.ts"],
})
