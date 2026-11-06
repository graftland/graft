/** Hosts traced entries with an ordinary exporter plugin in a private realm. */
import { Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Config } from "./Config"
import { Exporter } from "./Exporter"
import assembly from "./internal/assembly"

export { Config } from "./Config"

export default Plugin.make({
	name: "@graftland/plugin-otlp",
	config: Config,
	apply: Effect.fnUntraced(function* (config) {
		const child = yield* Graft.plugin(assembly, config, { isolate: [Exporter] })
		return Effect.fnUntraced(function* (next: Config) {
			yield* child.update(next)
			return true
		})
	}),
})
