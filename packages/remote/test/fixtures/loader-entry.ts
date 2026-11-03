import type { Plugin } from "@graftland/graft"
import { Config, Effect, FileSystem, Redacted } from "effect"
import * as Remote from "../../src/index"
import { contract } from "./services-contract"

// Importing the entry is pure. Configuration and certificate files are read on activation.
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
	contractModule: "remote-fixture",
})

export default entry
