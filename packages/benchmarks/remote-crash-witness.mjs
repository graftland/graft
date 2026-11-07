import { pathToFileURL } from "node:url"

import { makeRemote } from "./remote-fixture.mjs"
import { observeExecutions } from "./remote-native.mjs"

export const witness = async () => {
	const probe = observeExecutions()
	const fixture = await makeRemote("in-process", probe, {
		notice: (kind) => {
			if (kind === "crash")
				process.stdout.write(
					JSON.stringify({
						hostPid: process.pid,
						consumerActive: fixture.observer.activations,
						consumerFinalized: fixture.observer.finalizers,
						notice: true,
					}) + "\n",
				)
		},
	})
	const entry = await fixture.load()
	await fixture.run(entry.api.crash)
	throw new Error("The in-process crash did not terminate the host")
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
	witness().catch((error) => {
		process.stderr.write(String(error))
		process.exitCode = 1
	})
