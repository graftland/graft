import { Effect, Layer, Option, References } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as Http from "../src/Http.ts"
import { request, run, start } from "./utils.ts"

it.live(
	"keeps the request span and log level through a layer that captures context",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const handler = Effect.gen(function* () {
				const span = yield* Effect.currentSpan
				const parent = Option.getOrThrow(span.parent)
				const level = yield* References.CurrentLogLevel
				return HttpServerResponse.jsonUnsafe({
					kind: parent._tag === "Span" ? parent.kind : "external",
					level,
				})
			}).pipe(Effect.withSpan("handler"), Effect.orDie)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "captured-route",
					apply: () =>
						Http.mount(
							Layer.unwrap(
								Effect.map(Effect.context<never>(), (context) =>
									HttpRouter.add(
										"GET",
										"/context",
										handler.pipe(Effect.provideContext(context)),
									),
								),
							),
						).pipe(
							Effect.provideService(References.CurrentLogLevel, "Debug"),
							Effect.asVoid,
						),
				}),
			)
			yield* fork.await
			const response = yield* request(url + "/context")
			assert.strictEqual(response.status, 200)
			assert.strictEqual(response.text, '{"kind":"server","level":"Info"}')
		}).pipe(run),
)
