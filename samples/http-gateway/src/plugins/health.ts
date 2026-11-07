import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

/** GET /health, available for this plugin's lifetime. */
export default Plugin.make({
	name: "@graftland/sample-http-gateway/plugins/health",
	apply: () =>
		Http.mount(
			HttpRouter.add("GET", "/health", HttpServerResponse.text("ok\n")),
		).pipe(Effect.asVoid),
})
