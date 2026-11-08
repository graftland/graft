import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { prepare } from "./consumerFixture.mjs"

/** Owner-run proof against installed tarballs; all files stay inside the worktree. */
export function run() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
	const directory = prepare()
	try {
		cpSync(
			join(root, "samples/integration-gateway/src"),
			join(directory, "gateway/src"),
			{ recursive: true },
		)
		for (const [placement, strategy] of [
			["Worker", "Overlap"],
			["Process", "Overlap"],
			["Runner", "Restart"],
		]) {
			const output = execFileSync(
				process.execPath,
				["gateway/src/main.mjs", placement, strategy],
				{
					cwd: directory,
					encoding: "utf8",
					timeout: 60000,
					maxBuffer: 16 * 1024 * 1024,
				},
			)
			assert.ok(
				output.includes("Accepted") &&
					output.includes("Exited") &&
					/sessions: 1/.test(output),
				"Packed gateway proof failed: " + output,
			)
			process.stdout.write(output)
		}
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}
if (import.meta.main) run()
