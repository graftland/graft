import { Effect, Exit, FileSystem, Schema } from "effect"

import { Application } from "@graftland/cli/Application"
import { Change, Graft, Plugin } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

import { Forecast } from "@example/forecast-contract"

import { policy } from "./app.js"

/** The packed-consumer test loads this observer through the real CLI. */
export default Plugin.make({
	name: "@example/cli-check",
	config: Schema.Struct({
		deployment: Schema.Struct({
			artifact: Remote.Artifact.Artifact,
			contractModule: Schema.String,
			target: Schema.Union([
				Schema.TaggedStruct("Worker", {
					execArgv: Schema.optionalKey(Schema.Array(Schema.String)),
				}),
				Schema.TaggedStruct("Local", {}),
			]),
			input: Schema.Json,
		}),
		result: Schema.String,
	}),
	inject: [Forecast, FileSystem.FileSystem, Application],
	apply: Effect.fnUntraced(function* ({ deployment, result }) {
		const fs = yield* FileSystem.FileSystem
		const forecast = yield* Forecast
		const application = yield* Application
		const before = yield* forecast.get("London")
		const outcome = yield* Change.run({
			instance: "forecasts",
			candidate: Remote.candidate(deployment),
			policy,
		})
		const after = yield* forecast.get("London")
		const text = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Unknown),
		)({ before, outcome, after })
		yield* fs.writeFileString(result, text)
		yield* application.finish(Exit.void)
	}),
})
