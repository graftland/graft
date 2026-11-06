import { Array, Chunk, Effect, Ref } from "effect"
import { HttpRouter } from "effect/http"

import type { Route } from "../Http"

/** Records successful registrations, sharing the record across prefixed views. */
export const recording = (
	inner: HttpRouter.HttpRouter,
	recorded: Ref.Ref<Chunk.Chunk<Route>>,
	prefix: string,
): HttpRouter.HttpRouter => {
	const addAll: HttpRouter.HttpRouter["addAll"] = (routes) =>
		inner.addAll(routes).pipe(
			Effect.andThen(
				Ref.update(recorded, (current) =>
					Chunk.appendAll(
						current,
						Chunk.fromIterable(
							Array.map(routes, (route) => {
								// An empty prefix must preserve the root path and the bare wildcard.
								const full =
									prefix === "" ? route : HttpRouter.prefixRoute(route, prefix)
								return { method: full.method, path: full.path }
							}),
						),
					),
				),
			),
		)
	return HttpRouter.HttpRouter.of({
		...inner,
		addAll,
		add: (method, path, handler, options) =>
			addAll([HttpRouter.route(method, path, handler, options)]),
		prefixed: (path) =>
			recording(
				inner.prefixed(path),
				recorded,
				HttpRouter.prefixPath(path, prefix),
			),
	})
}
