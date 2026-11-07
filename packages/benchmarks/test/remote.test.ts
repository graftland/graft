// @effect-diagnostics-next-line nodeBuiltinImport:off -- Equivalence witnesses must run in fresh native processes to verify real child/worker exit.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { Array, String } from "effect"

import { describe, expect, it } from "vitest"

const directory = fileURLToPath(new URL("..", import.meta.url))
describe("Remote observable equivalence", { concurrent: false }, () => {
	it("checks identical work, lifecycle counts and native exits for every connection", () => {
		const result = spawnSync(process.execPath, ["remote-test-group.mjs"], {
			cwd: directory,
			encoding: "utf8",
			timeout: 60000,
		})
		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		// @effect-diagnostics-next-line globalJson:off -- Decode independent native witnesses at the process boundary.
		const facts: unknown = JSON.parse(result.stdout)
		expect(facts).toEqual(
			expect.arrayContaining(
				Array.map(
					[
						"in-process",
						"remote-local",
						"remote-worker",
						"remote-unix",
						"remote-ws",
						"raw-worker",
						"raw-ipc",
					],
					(connection) =>
						expect.objectContaining({
							connection,
							echoes: 4,
							batchEchoes: 2,
							executions: expect.objectContaining({ leftovers: 0 }),
						}),
				),
			),
		)
		if (!Array.isArray(facts)) throw new Error("Expected connection witnesses")
		expect(facts).toHaveLength(7)
		for (const fact of facts) {
			if (
				typeof fact !== "object" ||
				fact === null ||
				!("connection" in fact) ||
				typeof fact.connection !== "string"
			)
				throw new Error("Invalid connection witness")
			if (!String.startsWith("raw-")(fact.connection))
				expect(fact).toMatchObject({
					streamValues: [0, 1, 2, 3],
					updates: 1,
					logs: 4,
					crashVerified: fact.connection !== "in-process",
				})
		}
	}, 65000)

	it("verifies that an in-process exit terminates the host before finalizers", () => {
		const result = spawnSync(process.execPath, ["remote-crash-witness.mjs"], {
			cwd: directory,
			encoding: "utf8",
			timeout: 12000,
		})
		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(73)
		// @effect-diagnostics-next-line globalJson:off -- This is the controlled crashed-host witness protocol.
		const facts: unknown = JSON.parse(result.stdout)
		expect(facts).toMatchObject({
			notice: true,
			consumerActive: 1,
			consumerFinalized: 0,
		})
	})
	it("imports Remote executable modules without starting work", () => {
		const code =
			'await Promise.all(["remote-native","remote-fixture","remote-worker","remote-equivalence","remote-crash-witness","remote-raw"].map((n)=>import(`./${n}.mjs`)))'
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", code],
			{ cwd: directory, encoding: "utf8", timeout: 5000 },
		)
		expect(result.status, result.stderr).toBe(0)
		expect(result.stdout).toBe("")
	})
})
