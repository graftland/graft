import { Effect, Schedule, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

/** The response body stops when this plugin unloads. */
export default Plugin.make({
	name: "@graftland/sample-http-gateway/plugins/events",
	apply: () =>
		Http.mount(
			HttpRouter.add(
				"GET",
				"/events",
				HttpServerResponse.stream(
					Stream.repeat(
						Stream.make("data: alive\n\n"),
						Schedule.spaced("1 second"),
					).pipe(Stream.encodeText),
					{ contentType: "text/event-stream" },
				),
			),
		).pipe(Effect.asVoid),
})
