/**
 * What the gateway's plugins share. Routes are event handlers, so a route
 * exists exactly as long as the plugin that registered it is loaded.
 */
import { Context, Effect, Option, type Scope } from "effect"
import { HttpServerRequest, type HttpServerResponse } from "effect/http"

import { Event, type Graft } from "@graftland/graft"

/** Offered to every route in turn; the first route that answers wins. */
export const Route = Event.make<
	[request: HttpServerRequest.HttpServerRequest],
	Option.Option<HttpServerResponse.HttpServerResponse>
>("@graftland/sample-http-gateway/Route")

/** The address the server listens on. */
export class Gateway extends Context.Service<
	Gateway,
	{ readonly url: string }
>()("@graftland/sample-http-gateway/Gateway") {}

// The URL comes from the client. A malformed one matches no route.
const pathOf = (request: HttpServerRequest.HttpServerRequest) =>
	Option.map(HttpServerRequest.toURL(request), (url) => url.pathname)

/** Registers a handler for `method path` until the calling plugin stops. */
export const route = <R>(
	method: string,
	path: string,
	handle: (
		request: HttpServerRequest.HttpServerRequest,
	) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
): Effect.Effect<void, never, Graft.Graft | Scope.Scope | R> =>
	Event.on(Route, (request) =>
		request.method === method && Option.contains(pathOf(request), path)
			? Effect.asSome(handle(request))
			: Effect.succeedNone,
	)
