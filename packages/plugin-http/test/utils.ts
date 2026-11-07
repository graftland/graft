import {
	Array,
	Clock,
	Context,
	Deferred,
	Effect,
	Layer,
	Stream,
	type Scope,
} from "effect"
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	type HttpMethod,
} from "effect/http"

import { Graft, Plugin } from "@graftland/graft"

import * as Http from "../src/Http.ts"
import server from "../src/index.ts"
import router from "../src/router.ts"

export const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		Graft.Graft | Scope.Scope | HttpClient.HttpClient
	>,
) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(Layer.fresh(Graft.layer), FetchHttpClient.layer),
		),
	)
export const capture = Effect.fn("capture")(function* <I, S>(
	key: Context.Key<I, S>,
) {
	const result = yield* Deferred.make<S>()
	yield* Graft.plugin(
		Plugin.make({
			name: "capture",
			inject: [key],
			apply: () =>
				Effect.flatMap(Effect.service(key), (service) =>
					Effect.asVoid(Deferred.succeed(result, service)),
				),
		}),
	)
	return yield* Deferred.await(result)
})
export const start = Effect.gen(function* () {
	const core = yield* Graft.plugin(router)
	yield* core.await
	const fork = yield* Graft.plugin(server, { port: 0 })
	yield* fork.await
	return { fork, ...(yield* capture(Http.Server)) }
})
export const request = Effect.fn("request")(function* (
	url: string,
	method: HttpMethod.HttpMethod = "GET",
	headers: Record<string, string> = {},
) {
	const client = yield* HttpClient.HttpClient
	const response = yield* client.execute(
		HttpClientRequest.make(method)(url).pipe(
			HttpClientRequest.setHeaders(headers),
		),
	)
	return {
		status: response.status,
		text: yield* response.text,
		headers: response.headers,
	}
})
export const logText = (entry: Graft.LogEntry) =>
	Array.join(Array.map(Array.ensure(entry.message), String), " ")
export const logs = Effect.gen(function* () {
	const barrier = `log barrier ${yield* Clock.currentTimeNanos}`
	yield* Effect.log(barrier)
	return yield* Stream.runCollect(
		Stream.takeUntil(Graft.logs, (entry) => logText(entry) === barrier),
	)
})
