import { Effect, FiberSet, Schema, Stream } from "effect"

import * as Plugin from "@graftland/graft/Plugin"

import { Config, Integration } from "./shared.mjs"
import { connect } from "./socket.mjs"

const decode = Schema.decodeEffect(
	Schema.fromJsonString(
		Schema.Struct({ id: Schema.String, city: Schema.String }),
	),
)
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
export default Plugin.make({
	name: "gateway",
	config: Config,
	inject: [Integration],
	apply: (config) =>
		Effect.gen(function* () {
			const integration = yield* Integration
			const session = yield* Plugin.term
			const tasks = yield* FiberSet.make()
			const run = yield* FiberSet.runtime(tasks)()
			const upstream = yield* connect(config.upstream)
			yield* Plugin.fork(
				Stream.runForEach(upstream.lines, (line) =>
					decode(line).pipe(
						Effect.flatMap((request) =>
							Effect.sync(() =>
								run(
									integration.read(request.city).pipe(
										Effect.flatMap((value) =>
											encode({ id: request.id, session, ...value }),
										),
										Effect.flatMap(upstream.write),
										Effect.catchCause((cause) =>
											Effect.logError("Gateway request failed", cause),
										),
									),
								),
							),
						),
					),
				),
			)
			yield* encode({ id: "ready", session, term: session, version: 0 }).pipe(
				Effect.flatMap(upstream.write),
			)
		}),
})
