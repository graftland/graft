import { Effect, Option, Schema } from "effect"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpApiEndpoint,
	HttpApiGroup,
} from "effect/http-api"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as HttpApis from "../src/HttpApis.ts"
import { run, start } from "./utils.ts"

it.live(
	"parents HttpApi handler spans to the HTTP request rather than plugin activation",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const api = HttpApi.make("trace").add(
				HttpApiGroup.make("trace").add(
					HttpApiEndpoint.get("get", "/trace", { success: Schema.String }),
				),
			)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "traced-api",
					apply: () =>
						HttpApis.serve(
							api,
							["trace"],
							HttpApiBuilder.group(api, "trace", (h) =>
								h.handle("get", () =>
									Effect.map(Effect.currentSpan, (span) => {
										const parent = Option.getOrThrow(span.parent)
										return parent._tag === "Span" ? parent.kind : "external"
									}).pipe(Effect.withSpan("handler"), Effect.orDie),
								),
							),
						),
				}),
			)
			yield* fork.await
			const client = yield* HttpApiClient.make(api, { baseUrl: url })
			const kind = yield* client.trace.get()
			assert.strictEqual(kind, "server")
		}).pipe(run),
)
