import { Array, Effect, FileSystem, Record, Schema, String } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import * as Remote from "../src/index"

it.effect(
	"removes executable host activation and connection exports rather than keeping an adapter",
	() =>
		Effect.gen(function* () {
			assert.isFalse("plugin" in Remote)
			assert.isFalse("default" in Remote)
			const fs = yield* FileSystem.FileSystem
			const text = yield* fs.readFileString(
				new URL("../package.json", import.meta.url).pathname,
			)
			const metadata = yield* Schema.decodeEffect(
				Schema.fromJsonString(
					Schema.Struct({
						exports: Schema.Record(Schema.String, Schema.Unknown),
					}),
				),
			)(text)
			assert.isFalse(
				Array.some(
					Record.keys(metadata.exports),
					(key) =>
						String.startsWith("./host/")(key) ||
						String.startsWith("./runner")(key) ||
						key === "./Config" ||
						key === "./cli" ||
						key === "./schema",
				),
			)
		}).pipe(Effect.provide(NodeServices.layer)),
)
