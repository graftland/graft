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
	entry: [
		"src/index.ts",
		"src/Runner.ts",
		"src/bin.ts",
		"src/watchdog.ts",
		"src/Transport.ts",
		"src/Auth.ts",
		"src/Supervisor.ts",
		"src/host/local.ts",
		"src/host/websocket.ts",
		"src/host/auth/mtls.ts",
		"src/runner/supervisor.ts",
		"src/runner/websocket.ts",
		"src/runner/auth/mtls.ts",
		"src/host/unix.ts",
		"src/host/command.ts",
		"src/host/auth/none.ts",
		"src/runner/unix.ts",
		"src/runner/stdio.ts",
		"src/runner/auth/none.ts",
	],
})
