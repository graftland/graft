import { Effect, Schema } from "effect"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
} from "effect/http-api"

import { Plugin } from "@graftland/graft"

import * as HttpApis from "@fixture/plugin-http-api/HttpApis"

const api = HttpApi.make("entry").add(
	HttpApiGroup.make("entry").add(
		HttpApiEndpoint.get("get", "/entry", { success: Schema.String }),
	),
)
export default Plugin.make({
	name: "entry",
	apply: () =>
		HttpApis.serve(
			api,
			["entry"],
			HttpApiBuilder.group(api, "entry", (h) =>
				h.handle("get", () => Effect.succeed("loaded")),
			),
		),
})
