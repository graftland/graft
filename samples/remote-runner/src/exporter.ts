/**
 * The graft.yml entry. It runs the exporter on a runner and reads the runner's
 * address and certificate paths from environment variables.
 */
import type { Plugin } from "@graftland/graft"
import * as Remote from "@graftland/remote"
import { Config, Effect, FileSystem, Redacted } from "effect"
import { contract } from "./contract.ts"

// Importing the entry reads nothing. Settings and files are read on activation.
const target = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const read = (name: string) =>
		Config.String(name).pipe(Effect.flatMap((path) => fs.readFileString(path)))
	return Remote.runner({
		host: yield* Config.String("RUNNER_HOST"),
		port: yield* Config.Port("RUNNER_PORT"),
		tls: {
			servername: yield* Config.String("RUNNER_SERVERNAME"),
			ca: yield* read("RUNNER_CA"),
			cert: yield* read("RUNNER_CERT"),
			key: yield* read("RUNNER_KEY").pipe(Effect.map(Redacted.make)),
		},
	})
})

const entry: Plugin.Plugin = Remote.plugin(contract, {
	target,
	// Resolved in the runner's installation, not on the host.
	contractModule: "@graftland/sample-remote-runner/contract",
})

export default entry
