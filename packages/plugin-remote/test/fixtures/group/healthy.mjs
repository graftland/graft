import { Effect, FileSystem, Path } from "effect"

import { Plugin } from "@graftland/graft"

import { configuration } from "./shared.mjs"

export default Plugin.make({
	name: "group-healthy",
	config: configuration,
	apply: Effect.fn(function* (config) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const term = yield* Plugin.term
		yield* Effect.addFinalizer(() =>
			fs.writeFileString(
				path.join(config.directory, `closed-c-${term}`),
				"closed",
			),
		)
		yield* fs.writeFileString(
			path.join(config.directory, `active-c-${term}`),
			"ready",
		)
	}),
})
