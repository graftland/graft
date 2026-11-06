import { Effect, Schema } from "effect"

import { Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

import { Config } from "./Config"
import { host } from "./internal/host"

/** Compose live groups. Serving groups never depends on this plugin. */
export default Plugin.make({
	name: "@graftland/plugin-http-api",
	config: Config.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
	inject: [Http.Routes],
	apply: host,
})
