import { Effect, Redacted, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { Http } from "../src/Config.ts"
import { entries } from "../src/schema.ts"

it("registers the entry under its short and full names", () => {
	const [registration] = entries()
	assert.deepStrictEqual(registration?.names, [
		"otlp",
		"@graftland/plugin-otlp",
	])
	assert.isTrue(registration?.required)
	assert.deepNestedInclude(registration?.schema, {
		"anyOf[1].required": ["url", "serviceName", "plugins"],
	})
})

it("checks hosted entries against the composed Entry definition", () => {
	const registration = entries()[0]!
	assert.deepNestedInclude(registration.schema, {
		"anyOf[1].properties.plugins.allOf": [
			{ items: { $ref: "#/definitions/Entry" } },
		],
	})
})

it("registers the HTTP entry with both public names and a strict schema", () => {
	const registration = entries()[1]!
	assert.deepEqual(registration.names, [
		"otlp/http",
		"@graftland/plugin-otlp/http",
	])
	assert.deepInclude(registration.schema, {
		additionalProperties: false,
		required: ["url", "serviceName"],
	})
})

it.effect(
	"decodes defaults and environment strings without exposing header values",
	() =>
		Effect.gen(function* () {
			const defaults = yield* Schema.decodeEffect(Http)({
				url: "http://localhost:4318/v1/traces",
				serviceName: "test",
			})
			assert.deepEqual(
				{
					interval: defaults.exportInterval,
					batch: defaults.maxBatchSize,
					shutdown: defaults.shutdownTimeout,
					resource: defaults.resource,
					serialization: defaults.serialization,
					compression: defaults.compression,
				},
				{
					interval: 5000,
					batch: 1000,
					shutdown: 3000,
					resource: { serviceVersion: "", attributes: {} },
					serialization: "json",
					compression: "none",
				},
			)
			const decoded = yield* Schema.decodeEffect(Http)({
				url: defaults.url,
				serviceName: "test",
				exportInterval: "250",
				maxBatchSize: "12",
				shutdownTimeout: "750",
				headers: { authorization: "secret" },
			})
			assert.equal(decoded.exportInterval, 250)
			assert.equal(decoded.maxBatchSize, 12)
			assert.equal(decoded.shutdownTimeout, 750)
			assert.isTrue(Redacted.isRedacted(decoded.headers["authorization"]))
			for (const patch of [
				{ maxBatchSize: "0" },
				{ maxBatchSize: "1.5" },
				{ shutdownTimeout: "-1" },
				{ exportInterval: "NaN" },
				{ serialization: "unsupported" },
			]) {
				const result = yield* Effect.exit(
					Schema.decodeUnknownEffect(Http)({
						url: defaults.url,
						serviceName: "test",
						...patch,
					}),
				)
				assert.equal(result._tag, "Failure")
			}
		}),
)
