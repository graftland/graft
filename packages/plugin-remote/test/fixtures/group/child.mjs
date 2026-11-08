import { Effect, FileSystem, Path } from "effect"

import { Plugin } from "@graftland/graft"

import { configuration } from "./shared.mjs"

export default Plugin.make({
	name: "scope-child",
	config: configuration,
	apply: Effect.fn(function* (config) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const term = yield* Plugin.term
		yield* Effect.addFinalizer(() =>
			fs.writeFileString(
				path.join(config.directory, `closed-s-${term}`),
				"closed",
			),
		)
		yield* fs.writeFileString(
			path.join(config.directory, `active-s-${term}`),
			"ready",
		)
	}),
})
