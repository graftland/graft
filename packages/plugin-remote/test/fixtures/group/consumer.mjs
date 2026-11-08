import { Effect, FileSystem, Path } from "effect"

import { Plugin } from "@graftland/graft"

import { configuration, Value } from "./shared.mjs"

export default Plugin.make({
	name: "group-consumer",
	config: configuration,
	inject: [Value],
	apply: Effect.fn(function* (config) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const value = yield* Value
		const term = yield* Plugin.term
		yield* Effect.addFinalizer(() =>
			fs.writeFileString(
				path.join(config.directory, `closed-b-${term}`),
				"closed",
			),
		)
		yield* fs.writeFileString(
			path.join(config.directory, `active-b-${term}`),
			String(value.term),
		)
	}),
})
