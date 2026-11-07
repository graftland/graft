import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { test } from "vitest"

test(
	"independent and first-party authors publish and conform through installed public exports",
	{ timeout: 180_000 },
	() => {
		try {
			execFileSync(
				"node",
				[
					fileURLToPath(new URL("./packed-ecosystem.mjs", import.meta.url)),
					"test",
				],
				{
					stdio: "pipe",
					timeout: 175_000,
					maxBuffer: 16 * 1024 * 1024,
				},
			)
		} catch (cause) {
			throw new Error(
				`Installed ecosystem tests failed:\n${cause.stdout?.toString() ?? ""}\n${cause.stderr?.toString() ?? ""}`,
				{ cause },
			)
		}
	},
)
