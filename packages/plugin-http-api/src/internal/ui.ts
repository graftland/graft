import {
	Cause,
	Effect,
	Layer,
	ScopedRef,
	Stream,
	SubscriptionRef,
} from "effect"
import { HttpRouter } from "effect/http"
import { type HttpApi } from "effect/http-api"

import { Plugin } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

import { Document } from "../HttpApis"

/** Keep the outer mount fixed while replacing the resources behind it. */
export const ui = Effect.fn("HttpApis.ui")(function* (
	path: `/${string}`,
	layer: (api: HttpApi.Top) => Layer.Layer<never, never, HttpRouter.HttpRouter>,
) {
	const document = yield* Document
	const initial = yield* SubscriptionRef.get(document)
	const app = yield* ScopedRef.fromAcquire(
		HttpRouter.toHttpEffect(layer(initial.api)),
	)
	yield* Http.mount(
		HttpRouter.add("GET", path, Effect.flatten(ScopedRef.get(app))),
	)
	yield* Plugin.fork(
		Stream.runForEach(SubscriptionRef.changes(document), ({ api }) =>
			ScopedRef.set(app, HttpRouter.toHttpEffect(layer(api))).pipe(
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterrupts(cause),
					(cause) =>
						Effect.logError(
							"Could not refresh the documentation UI; keeping the previous snapshot",
							cause,
						),
				),
			),
		),
	)
})
