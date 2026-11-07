import {
	Config,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Ref,
	Schema,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import type { Controller } from "@graftland/plugin-mcp-server/Projection"

import type { Forecast } from "@example/forecast-contract"

import { start } from "./app.js"
import { expose, view } from "./mcp.js"

const program = Effect.gen(function* () {
	const file = yield* Config.String("GRAFT_GATEWAY_STATUS")
	const ready = yield* Deferred.make<Controller<Forecast>>()
	const app = yield* start(
		new URL("../../", import.meta.url).pathname,
		{ _tag: "Worker", execArgv: [] },
		(release, action) =>
			Deferred.await(ready).pipe(
				Effect.flatMap((controller) =>
					controller.updateAfter(
						action,
						[view(release)],
						(outcome) => outcome._tag === "Accepted",
					),
				),
			),
	)
	const endpoint = yield* expose(app, "stdio")
	yield* Deferred.succeed(ready, endpoint.controller)
	const fs = yield* FileSystem.FileSystem
	const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
		operator: app.operatorUrl,
		session: app.session,
		logins: yield* Ref.get(app.upstream.logins),
	})
	yield* fs.writeFileString(file, json)
	return yield* Effect.never
})

NodeRuntime.runMain(
	program.pipe(
		Effect.scoped,
		Effect.provideService(Logger.LogToStderr, true),
		Effect.provide(
			Graft.layer.pipe(
				Layer.provideMerge(
					Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
				),
			),
		),
	),
)
