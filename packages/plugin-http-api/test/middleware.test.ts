import { Array, Effect, Schema } from "effect"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSecurity,
} from "effect/http-api"
import { assert, it } from "@effect/vitest"

import { Plugin } from "@graftland/graft"

import * as HttpApis from "../src/HttpApis.ts"
import { compose } from "../src/internal/compose.ts"

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
