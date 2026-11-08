import { createRequire } from "node:module"

import { Effect, FileSystem, Path, Schema } from "effect"

import { Plugin } from "@graftland/graft"

const addon = createRequire(import.meta.url)("./addon.node")

export default Plugin.make({
	name: "native-addon-fixture",
	config: Schema.Struct({ directory: Schema.String, marker: Schema.String }),
	apply: Effect.fn(function* (config) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		yield* fs.writeFileString(
			path.join(config.directory, config.marker),
			`${addon.pid}:${addon.next()}`,
		)
	}),
})
