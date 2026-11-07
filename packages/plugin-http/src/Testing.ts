/** Listener conformance checks. Run against an isolated listener on an ephemeral port. */
import { Deferred, Effect, Fiber, Schema } from "effect"
import { HttpClient, HttpRouter, HttpServerResponse } from "effect/http"

import { Graft, Plugin } from "@graftland/graft"

import * as Http from "./Http"

/** A listener did not meet the public serving contract. */
export class ConformanceError extends Schema.TaggedError<
	ConformanceError,
	{ readonly brand: unique symbol }
>()("ConformanceError", { check: Schema.String }) {}
const expectStatus = Effect.fn("Testing.expectStatus")(function* (
	url: string,
	expected: number,
) {
	const client = yield* HttpClient.HttpClient
	const response = yield* client.get(url)
	yield* response.text
	if (response.status !== expected)
		return yield* ConformanceError.make({
			check: `${url}: expected ${expected}, got ${response.status}`,
		})
})
/** Check mounting, conflict exclusion, restoration, unmounting and interruption of requests. */
export const listener = Effect.fn("Testing.listener")(function* (url: string) {
	const route = Plugin.make({
		name: "@graftland/plugin-http/Testing/route",
		apply: () =>
			Http.mount(
				HttpRouter.add(
					"GET",
					"/__listener_test",
					HttpServerResponse.text("ok"),
				),
			).pipe(Effect.asVoid),
	})
	const first = yield* Graft.plugin(route)
	yield* first.await
	yield* expectStatus(`${url}/__listener_test`, 200)
	const second = yield* Graft.plugin(route)
	yield* second.await
	yield* expectStatus(`${url}/__listener_test`, 404)
	yield* second.dispose
	yield* expectStatus(`${url}/__listener_test`, 200)
	yield* first.dispose
	yield* expectStatus(`${url}/__listener_test`, 404)
	const entered = yield* Deferred.make<void>(),
		finalized = yield* Deferred.make<void>()
	const slow = yield* Graft.plugin(
		Plugin.make({
			name: "@graftland/plugin-http/Testing/slow",
			apply: () =>
				Http.mount(
					HttpRouter.add(
						"GET",
						"/__listener_slow",
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(Deferred.succeed(finalized, undefined)),
						),
					),
				).pipe(Effect.asVoid),
		}),
	)
	yield* slow.await
	const pending = yield* expectStatus(`${url}/__listener_slow`, 503).pipe(
		Effect.forkScoped,
	)
	yield* Deferred.await(entered)
	yield* slow.dispose
	yield* Fiber.join(pending)
	const closed = yield* Deferred.isDone(finalized)
	if (!closed)
		return yield* ConformanceError.make({
			check: "Request finalizer did not run",
		})
}, Effect.scoped)
