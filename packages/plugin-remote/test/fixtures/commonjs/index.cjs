"use strict"
// A CommonJS plugin: require() loads the ESM framework packages.
const { Effect, FileSystem, Path, Schema } = require("effect")
const { Plugin } = require("@graftland/graft")

module.exports = Plugin.make({
	name: "commonjs-fixture",
	config: Schema.Struct({ directory: Schema.String }),
	apply: (config) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			yield* fs.writeFileString(
				path.join(config.directory, "commonjs"),
				"served",
			)
		}),
})
