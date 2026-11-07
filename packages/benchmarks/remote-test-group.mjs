import { pathToFileURL } from "node:url"
import { inspect } from "node:util"

import { equivalence } from "./remote-equivalence.mjs"
import { captureNativeStdout } from "./remote-native.mjs"

export const group = async () => {
	const facts = []
	for (const connection of [
		"in-process",
		"remote-local",
		"remote-worker",
		"remote-unix",
		"remote-ws",
		"raw-worker",
		"raw-ipc",
	])
		facts.push(await equivalence(connection))
	return facts
}
if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	const stdout = captureNativeStdout()
	group().then(
		(facts) => {
			stdout.restore()
			process.stdout.write(JSON.stringify(facts) + "\n")
		},
		(error) => {
			stdout.restore()
			process.stderr.write(inspect(error, { depth: null }))
			process.exitCode = 1
		},
	)
}
