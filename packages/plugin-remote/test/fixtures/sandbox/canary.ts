/**
 * A hostile plugin for the confinement tests. It tries to read a host file, a host
 * secret in its environment, the host network and to start a process; any success
 * fails its start, so it serves only when every attempt was blocked.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The hostile fixture deliberately bypasses Effect's platform services.
import { execFileSync } from "node:child_process"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The hostile fixture deliberately bypasses Effect's platform services.
import { readFileSync } from "node:fs"
import process from "node:process"

import { Array, Effect, Record, Schema } from "effect"

import { Plugin } from "@graftland/graft"

import * as Contract from "../../../src/Contract"

// Plain strings: this bundle carries its own Effect copy, whose refinements the unit does not share.
const Config = Schema.Struct({ secretFile: Schema.String, port: Schema.String })

export const contract = Contract.make({
	name: "sandbox-canary",
	config: Config,
})

const blocked = (attempt: () => unknown) =>
	Effect.sync(() => {
		try {
			attempt()
			return false
		} catch {
			return true
		}
	})
const unreachable = (port: string) =>
	Effect.tryPromise({
		// @effect-diagnostics-next-line globalFetchInEffect:off -- The hostile fixture deliberately bypasses the broker.
		try: (signal) => fetch(`http://127.0.0.1:${port}/`, { signal }),
		catch: () => "Blocked" as const,
	}).pipe(
		Effect.as(false),
		Effect.orElseSucceed(() => true),
	)

export default Plugin.make({
	name: "sandbox-canary",
	config: Config,
	apply: ({ secretFile, port }) =>
		Effect.gen(function* () {
			const results = {
				file: yield* blocked(() => readFileSync(secretFile, "utf8")),
				// @effect-diagnostics-next-line processEnvInEffect:off -- The hostile fixture deliberately looks for host credentials.
				environment: process.env["GRAFT_TEST_HOST_SECRET"] === undefined,
				network: yield* unreachable(port),
				process: yield* blocked(() => execFileSync("/bin/sh", ["-c", "true"])),
			}
			const escaped = Array.filter(Record.keys(results), (key) => !results[key])
			if (escaped.length > 0)
				return yield* Effect.die(
					`Escaped the sandbox: ${Array.join(escaped, ", ")}`,
				)
		}),
})
