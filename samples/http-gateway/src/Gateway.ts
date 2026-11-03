/**
 * What the gateway's plugins share. Routes are event handlers, so a route
 * exists exactly as long as the plugin that registered it is loaded.
 */
import { Event, type Graft } from "@graftland/graft"
import type { Scope } from "effect"
import { Context, Effect, Option } from "effect"
import type { HttpServerRequest, HttpServerResponse } from "effect/http"

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

const pathOf = (request: HttpServerRequest.HttpServerRequest) =>
	new URL(request.url, "http://gateway").pathname

/** Registers a handler for `method path` until the calling plugin stops. */
export const route = <R>(
	method: string,
	path: string,
	handle: (
		request: HttpServerRequest.HttpServerRequest,
	) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
): Effect.Effect<void, never, Graft.Graft | Scope.Scope | R> =>
	Event.on(Route, (request) =>
		request.method === method && pathOf(request) === path
			? Effect.asSome(handle(request))
			: Effect.succeedNone,
	)
