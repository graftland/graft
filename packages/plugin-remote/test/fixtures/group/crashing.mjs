import { Effect, FileSystem, Path, Schema } from "effect"

import { Plugin } from "@graftland/graft"

/** Writes one marker per start; the first start exits its unit shortly afterwards. */
export default Plugin.make({
	name: "group-crashing",
	config: Schema.Struct({ directory: Schema.String }),
	apply: Effect.fn(function* (config) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const crashed = path.join(config.directory, "crashed")
		const term = yield* Plugin.term
		yield* fs.writeFileString(
			path.join(config.directory, `started-${term}`),
			"ready",
		)
		if (!(yield* fs.exists(crashed))) {
			yield* fs.writeFileString(crashed, "once")
			yield* Plugin.fork(
				Effect.sleep("200 millis").pipe(
					Effect.andThen(Effect.sync(() => process.exit(1))),
				),
			)
		}
	}),
})
