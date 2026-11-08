import { Effect, FileSystem, Layer, Path } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Units from "../src/Units"

const budget = {
	total: 20000,
	startup: 3000,
	probe: 500,
	drain: 500,
	stop: 500,
	terminate: 1000,
}

for (const placement of ["Worker", "Process"] as const)
	it.live(
		`serves a CommonJS plugin module in a ${placement} unit (C9 support matrix)`,
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const cache = new URL("../.cache/module-format-tests/", import.meta.url)
					.pathname
				yield* fs.makeDirectory(cache, { recursive: true })
				const directory = yield* fs.makeTempDirectoryScoped({
					directory: cache,
				})
				const artifact = yield* Artifact.capture({
					directory: new URL("./fixtures/commonjs/", import.meta.url).pathname,
					module: "index.cjs",
					store: path.join(directory, "artifacts"),
				})
				const target = Units.target({
					artifact,
					input: { directory },
					placement,
				})
				const result = yield* Change.run({
					operations: [{ _tag: "Deploy", instance: "commonjs", target }],
					budget,
				}).pipe(
					Effect.provide(
						Kernel.layer({
							authority: "module-formats",
							maxUnits: 4,
							instances: [{ id: "commonjs", target }],
						}).pipe(Layer.provide(Units.layer)),
					),
				)
				assert.equal(result.outcome, "Accepted")
				const marker = yield* fs.readFileString(
					path.join(directory, "commonjs"),
				)
				assert.equal(marker, "served")
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30000,
	)
