import { Array, Effect, LogLevel, Record, Schema } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { make } from "../src/internal/configSchema"
import { registrations } from "../src/internal/intercepts"

const Shape = Schema.Struct({
	required: Schema.Array(Schema.String),
	properties: Schema.Struct({
		config: Schema.Record(Schema.String, Schema.Unknown),
	}),
})

/** The parts of the generated document that editors rely on. */
const Generated = Schema.Struct({
	$schema: Schema.String,
	definitions: Schema.Struct({
		Entry: Schema.Struct({ anyOf: Schema.Tuple([Shape, Shape]) }),
		Intercept: Schema.Struct({
			additionalProperties: Schema.Boolean,
			properties: Schema.Record(
				Schema.String,
				Schema.Struct({
					enum: Schema.optionalKey(Schema.Array(Schema.String)),
				}),
			),
		}),
	}),
})

const generated = Schema.decodeUnknownEffect(Generated)(make())

describe("config file schema", () => {
	it.effect(
		"checks a group's config as a list of entries, and leaves a plugin's open",
		() =>
			Effect.gen(function* () {
				const schema = yield* generated
				const [group, plugin] = schema.definitions.Entry.anyOf
				assert.strictEqual(
					schema.$schema,
					"http://json-schema.org/draft-07/schema#",
				)
				assert.deepStrictEqual(group.properties.config["items"], {
					$ref: "#/definitions/Entry",
				})
				assert.deepStrictEqual(group.required, ["name", "group"])
				assert.deepStrictEqual(plugin.required, ["name"])
				assert.isUndefined(plugin.properties.config["type"])
			}),
	)

	it.effect("accepts exactly the intercepts graft start registers", () =>
		Effect.gen(function* () {
			const intercept = (yield* generated).definitions.Intercept
			assert.isFalse(intercept.additionalProperties)
			assert.deepStrictEqual(
				Record.keys(intercept.properties),
				Array.map(registrations, ({ key }) => key),
			)
			assert.deepStrictEqual(
				intercept.properties["effect/References/MinimumLogLevel"]?.enum,
				LogLevel.values,
			)
		}),
	)

	it("leaves every plugin's config to graft schema, first-party ones included", () => {
		assert.isUndefined(make().definitions.Entry.allOf)
	})
})
