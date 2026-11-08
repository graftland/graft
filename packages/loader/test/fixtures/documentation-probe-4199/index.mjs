import {
	Context,
	Deferred,
	Effect,
	Queue,
	Record,
	Schema,
	Stream,
	SubscriptionRef,
} from "effect"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
} from "effect/http-api"
import { assert } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as HttpApis from "@fixture/plugin-http-api/HttpApis"
import * as Http from "@fixture/plugin-http/Http"

const capture = Effect.fnUntraced(function* (key) {
	const result = yield* Deferred.make()
	yield* Graft.plugin(
		Plugin.make({
			name: "capture",
			inject: [key],
			apply: () =>
				Effect.flatMap(key, (value) => Deferred.succeed(result, value)),
		}),
	)
	return yield* Deferred.await(result)
})
const waitFor = (ref, predicate) =>
	SubscriptionRef.changes(ref).pipe(
		Stream.filter(predicate),
		Stream.runHead,
		Effect.timeout("3 seconds"),
	)

const State = Context.Service("loader/fixture/documentation-probe-4199")
export default Plugin.make({
	name: "probe",
	config: Schema.Struct({
		path: Schema.TemplateLiteral(["/", Schema.String]),
	}),
	inject: [State, Http.Server, Http.Routes],
	apply: (...args) =>
		Effect.flatMap(State, ({ page, results }) =>
			(({ path }) =>
				Effect.gen(function* () {
					const api = HttpApi.make("probe").add(
						HttpApiGroup.make("probe").add(
							HttpApiEndpoint.get("get", path, { success: Schema.String }),
						),
					)
					yield* HttpApis.serve(
						api,
						["probe"],
						HttpApiBuilder.group(api, "probe", (h) =>
							h.handle("get", () => Effect.succeed(path)),
						),
					)
					if (page === "http-api") {
						const document = yield* capture(HttpApis.Document)
						yield* waitFor(document, ({ spec }) => Record.has(spec.paths, path))
						assert.deepStrictEqual(
							Record.keys((yield* SubscriptionRef.get(document)).spec.paths),
							[path],
						)
					}
					const server = yield* Http.Server
					const routes = yield* Http.Routes
					yield* Queue.offer(results, { url: server.url, path, routes })
				}))(...args),
		),
})
