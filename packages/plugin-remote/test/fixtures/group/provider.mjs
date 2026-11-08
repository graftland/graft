import { Effect, FileSystem, Path, Schedule } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import child from "./child.mjs"
import { configuration, Value } from "./shared.mjs"

export const deployment = {
	children: [
		{ name: "scope-child", module: "./child.mjs", input: { _tag: "Parent" } },
	],
}
export default Plugin.make({
	name: "group-provider",
	config: configuration,
	provides: [Value],
	apply: Effect.fn(function* (config) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const term = yield* Plugin.term
		yield* Effect.addFinalizer(() =>
			config.fault === "blocked" && term === 1
				? fs
						.writeFileString(
							path.join(config.directory, "blocked-a"),
							"entered",
						)
						.pipe(Effect.andThen(Effect.never))
				: fs.writeFileString(
						path.join(config.directory, `closed-a-${term}`),
						"closed",
					),
		)
		yield* Graft.provide(Value, { term })
		yield* Graft.plugin(child, config, { declaration: "scope-child" })
		yield* fs.writeFileString(
			path.join(config.directory, `active-a-${term}`),
			"ready",
		)
		if (config.fault !== "none" && term === 1)
			yield* Plugin.fork(
				fs.exists(path.join(config.directory, "fail-a")).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("10 millis"),
						until: (exists) => exists,
					}),
					Effect.andThen(
						fs.writeFileString(
							path.join(config.directory, "failure-a"),
							"entered",
						),
					),
					Effect.andThen(Effect.die("Ordinary provider failure")),
				),
			)
	}),
})
