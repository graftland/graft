import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"

import { Plugin } from "@graftland/graft"

import { route } from "../Gateway.ts"

/** `GET /health`. */
export default Plugin.make({
	name: "health",
	apply: () =>
		route("GET", "/health", () =>
			Effect.succeed(HttpServerResponse.text("ok\n")),
		),
})
