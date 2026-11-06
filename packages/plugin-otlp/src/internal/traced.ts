import { Effect, Tracer } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Group } from "@graftland/loader"

import { Exporter } from "../Exporter"

export default Plugin.make({
	name: "@graftland/plugin-otlp/internal/traced",
	config: Entry.Entries,
	inject: [Exporter],
	apply: Effect.fnUntraced(function* (entries) {
		const tracer = yield* Exporter
		const subtree = yield* Graft.plugin(Group.Group, entries, {
			intercept: [Graft.intercept(Tracer.Tracer, () => tracer)],
		})
		return Effect.fnUntraced(function* (next: typeof Entry.Entries.Type) {
			yield* subtree.update(next)
			return true
		})
	}),
})
