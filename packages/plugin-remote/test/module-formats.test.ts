import { Effect, FileSystem, Layer, Path, String } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"

import { inject } from "vitest"

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

declare module "vitest" {
	interface ProvidedContext {
		nativeAddonSkipReason: string
	}
}

it.live(
	"loads a captured N-API addon in fresh Process units across replacement (C9 support matrix)",
	(context) =>
		Effect.gen(function* () {
			const skipReason = inject("nativeAddonSkipReason")
			if (skipReason !== "") return context.skip(skipReason)
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const cache = new URL("../.cache/module-format-tests/", import.meta.url)
				.pathname
			yield* fs.makeDirectory(cache, { recursive: true })
			const directory = yield* fs.makeTempDirectoryScoped({ directory: cache })
			const artifact = yield* Artifact.capture({
				directory: new URL("../.cache/native-addon/", import.meta.url).pathname,
				module: "index.mjs",
				store: path.join(directory, "artifacts"),
			})
			const target = (marker: string) =>
				Units.target({
					artifact,
					input: { directory, marker },
					placement: "Process",
				})
			yield* Effect.gen(function* () {
				for (const marker of ["first", "replacement"]) {
					const result = yield* Change.run({
						operations: [
							{
								_tag: "Deploy",
								instance: "native-addon",
								target: target(marker),
							},
						],
						strategy: "Restart",
						budget: { ...budget, total: 60000, startup: 10000 },
					})
					assert.equal(result.outcome, "Accepted")
				}
			}).pipe(
				Effect.provide(
					Kernel.layer({
						authority: "native-addon",
						maxUnits: 4,
						instances: [{ id: "native-addon", target: target("first") }],
					}).pipe(Layer.provide(Units.layer)),
				),
			)
			const firstMarker = yield* fs.readFileString(
				path.join(directory, "first"),
			)
			const replacementMarker = yield* fs.readFileString(
				path.join(directory, "replacement"),
			)
			const first = String.split(firstMarker, ":")
			const replacement = String.split(replacementMarker, ":")
			assert.equal(first[1], "1")
			assert.equal(replacement[1], "1")
			assert.notEqual(first[0], replacement[0])
			assert.notEqual(Number(first[0]), process.pid)
			assert.notEqual(Number(replacement[0]), process.pid)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	90000,
)
