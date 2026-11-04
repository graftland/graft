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
			"./worker": "./dist/worker.js",
		},
	},
	entry: [
		"src/index.ts",
		"src/runner/index.ts",
		"src/Contract.ts",
		"src/Runner.ts",
		"src/bin.ts",
		"src/watchdog.ts",
		"src/worker.ts",
		"src/host/worker.ts",
		"src/Transport.ts",
		"src/Auth.ts",
		"src/Errors.ts",
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
		"src/host/auth/bearer.ts",
		"src/host/auth/jwt.ts",
		"src/runner/auth/bearer.ts",
		"src/runner/auth/jwt.ts",
	],
})
