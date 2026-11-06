import { Effect, Schema } from "effect"
import { HttpApiScalar } from "effect/http-api"

import { Plugin } from "@graftland/graft"

import { UiConfig } from "./Config"
import { Document } from "./HttpApis"
import { ui } from "./internal/ui"

/** Serve the live document using Effect's Scalar UI. */
export default Plugin.make({
	name: "@graftland/plugin-http-api/scalar",
	config: UiConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
	inject: [Document],
	apply: ({ path }) => ui(path, (api) => HttpApiScalar.layer(api, { path })),
})
