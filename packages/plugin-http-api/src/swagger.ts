import { Effect, Schema } from "effect"
import { HttpApiSwagger } from "effect/http-api"

import { Plugin } from "@graftland/graft"

import { UiConfig } from "./Config"
import { Document } from "./HttpApis"
import { ui } from "./internal/ui"

/** Serve the live document using Effect's Swagger UI. */
export default Plugin.make({
	name: "@graftland/plugin-http-api/swagger",
	config: UiConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
	inject: [Document],
	apply: ({ path }) => ui(path, (api) => HttpApiSwagger.layer(api, { path })),
})
