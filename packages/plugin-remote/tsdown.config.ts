import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	exports: {
		...config.exports,
		// Executables run in plain Node, even when the host uses source conditions.
		customExports: (exports) => ({
			...Object.fromEntries(
				Object.entries(exports).filter(
					([name]) => name !== "./bin" && !name.startsWith("./internal/"),
				),
			),
			"./internal/bin": "./dist/bin.js",
			"./internal/watchdog": "./dist/internal/watchdogMain.js",
			"./internal/worker": "./dist/internal/workerMain.js",
		}),
	},
	entry: [
		"src/index.ts",
		"src/runner/index.ts",
		"src/Contract.ts",

		"src/bin.ts",
		"src/internal/watchdogMain.ts",
		"src/internal/workerMain.ts",
		"src/host/worker.ts",
		"src/Transport.ts",
		"src/Auth.ts",
		"src/Errors.ts",
		"src/Testing.ts",

		"src/host/local.ts",
		"src/host/websocket.ts",
		"src/host/auth/mtls.ts",

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
