import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"

import { test } from "vitest"

import { prepare } from "./packed-gateway.mjs"

test(
	"independent installed packages keep a WebSocket gateway alive through Worker and child transitions",
	{ timeout: 180_000 },
	() => {
		const directory = prepare()
		try {
			execFileSync("node", ["--test", "test/gateway.test.mjs"], {
				cwd: directory,
				stdio: "pipe",
				timeout: 120_000,
			})
		} catch (cause) {
			throw new Error(
				`Installed gateway tests failed:
${cause.stdout?.toString() ?? ""}
${cause.stderr?.toString() ?? ""}`,
				{ cause },
			)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	},
)
