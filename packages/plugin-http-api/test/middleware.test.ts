import { Array, Effect, Option, Redacted, Schema, Stream } from "effect"
import { HttpClientRequest } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSecurity,
} from "effect/http-api"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as HttpApis from "../src/HttpApis.ts"
import { compose } from "../src/internal/compose.ts"
import { request, run, start } from "./utils.ts"

class Unauthorized extends Schema.TaggedError<
	Unauthorized,
	{ readonly brand: unique symbol }
>()("Unauthorized", {}, { httpApiStatus: 401 }) {}
class Authorization extends HttpApiMiddleware.Service<Authorization>()(
	"@graftland/plugin-http-api/test/middleware.test/Authorization",
	{ error: Unauthorized, security: { bearer: HttpApiSecurity.bearer } },
) {}
const api = HttpApi.make("auth").add(
	HttpApiGroup.make("private")
		.add(HttpApiEndpoint.get("get", "/private", { success: Schema.String }))
		.middleware(Authorization),
)
const handlers = HttpApiBuilder.group(api, "private", (h) =>
	h.handle("get", () => Effect.succeed("private")),
)
const feature = Plugin.make({
	name: "private",
	inject: [Authorization],
	apply: () => HttpApis.serve(api, ["private"], handlers),
})
const auth = (accepted: string) =>
	Plugin.make({
		name: "auth",
		apply: () =>
			Graft.provide(Authorization, {
				bearer: (effect, { credential }) =>
					Redacted.value(credential) === accepted
						? effect
						: Effect.fail(Unauthorized.make({})),
			}),
	})
const clientLayer = (token: string) =>
	HttpApiMiddleware.layerClient(Authorization, ({ request, next }) =>
		next(HttpClientRequest.bearerToken(request, token)),
	)

it.live(
	"injects bearer middleware, follows replacement, and becomes pending after withdrawal",
	() =>
		Effect.gen(function* () {
			const { url } = yield* start
			const first = auth("first"),
				second = auth("second")
			const provider = yield* Graft.plugin(first)
			yield* provider.await
			const fork = yield* Graft.plugin(feature)
			yield* fork.await
			assert.strictEqual((yield* request(`${url}/private`)).status, 401)
			const client = yield* HttpApiClient.make(api, { baseUrl: url }).pipe(
				Effect.provide(clientLayer("first")),
			)
			const value = yield* client.private.get()
			assert.strictEqual(value, "private")
			yield* Graft.replace([[first, second]])
			yield* Stream.runHead(
				Stream.filter(fork.state, (state) => state._tag === "Active"),
			)
			const denied = yield* Effect.flip(client.private.get())
			assert.isTrue(Schema.is(Unauthorized)(denied))
			const updated = yield* HttpApiClient.make(api, { baseUrl: url }).pipe(
				Effect.provide(clientLayer("second")),
			)
			const changed = yield* updated.private.get()
			assert.strictEqual(changed, "private")
			yield* provider.dispose
			const state = yield* Stream.runHead(fork.state)
			assert.strictEqual(Option.getOrThrow(state)._tag, "Pending")
			assert.strictEqual((yield* request(`${url}/private`)).status, 404)
		}).pipe(run),
)

Plugin.make({
	name: "missing-inject",
	// @ts-expect-error The middleware requirement must appear in inject.
	// @effect-diagnostics-next-line missingEffectContext:off -- this negative type test deliberately omits Authorization
	apply: () => HttpApis.serve(api, ["private"], handlers),
})

it.effect(
	"detects incompatible security schemes with their original cause",
	() =>
		Effect.gen(function* () {
			class Other extends HttpApiMiddleware.Service<Other>()(
				"@graftland/plugin-http-api/test/middleware.test/Other",
				{
					security: {
						bearer: HttpApiSecurity.apiKey({ key: "x-key", in: "header" }),
					},
				},
			) {}
			const other = HttpApiGroup.make("other")
				.add(HttpApiEndpoint.get("get", "/other"))
				.middleware(Other)
			const result = yield* Effect.fromResult(
				compose([api.groups.private, other]),
			)
			assert.isEmpty(result.spec.paths)
			assert.lengthOf(result.conflicts, 1)
			assert.include(
				`${result.conflicts[0]?.cause}`,
				"Conflicting OpenAPI security scheme",
			)
			assert.deepStrictEqual(Array.fromIterable(result.conflicts[0]!.groups), [
				"other",
				"private",
			])
		}),
)
