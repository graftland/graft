/** The implementation. It runs on the runner, in a process of its own. */
import { Graft, Plugin } from "@graftland/graft"
import * as Remote from "@graftland/remote"
import { Effect } from "effect"
import process from "node:process"
import { config, Exporter, Ledger } from "./contract.ts"

export default Plugin.make({
	name: "invoice-exporter",
	config,
	// Provided by the host, reached over the connection.
	inject: [Ledger],
	apply: ({ destination }) =>
		Effect.gen(function* () {
			const ledger = yield* Ledger
			// The runner gives each admission of this instance a larger generation.
			const { id, generation } = yield* Remote.Instance
			yield* Graft.provide(Exporter, {
				export: (invoice) =>
					ledger
						.append({ invoice, destination, instance: id, generation })
						.pipe(Effect.as({ invoice, generation, pid: process.pid })),
			})
		}),
})
