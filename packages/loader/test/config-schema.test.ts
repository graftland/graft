import { JsonSchema, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { ConfigSchema, Entry } from "../src/index"

it("constrains registered names outside the fallback union and inside groups", () => {
	const config = {
		type: "object",
		required: ["url"],
		properties: { url: { type: "string" } },
	}
	const document = ConfigSchema.make({
		entries: [
			{
				names: ["transport", "example/transport"],
				schema: config,
				required: true,
			},
		],
	})
	assert.deepEqual(document.definitions.Entry.allOf, [
		{
			if: {
				properties: {
					name: { enum: ["transport", "example/transport"] },
					group: { const: false },
				},
				required: ["name"],
			},
			then: { properties: { config }, required: ["config"] },
		},
	])
	// Constraints sit beside the union, so the open plugin branch cannot bypass them.
	assert.property(document.definitions.Entry, "anyOf")
})

it("routes hosted entries through registered child config constraints", () => {
	const host = JsonSchema.toDocumentDraft07(
		Schema.toJsonSchemaDocument(Schema.Struct({ plugins: Entry.Entries }), {
			onExcessProperty: "error",
		}),
	).schema
	const child = {
		type: "object",
		properties: { token: { type: "string" } },
		required: ["token"],
	}
	const document = ConfigSchema.make({
		entries: [
			{ names: ["host"], schema: host, required: true },
			{ names: ["child"], schema: child, required: true },
		],
	})
	// No JSON Schema validator is installed. Check the complete reference/condition chain:
	// this nested input must fail the child's required string token constraint.
	const invalid = [
		{
			name: "host",
			config: { plugins: [{ name: "child", config: { token: 42 } }] },
		},
	]
	assert.deepNestedInclude(host, {
		"properties.plugins.allOf": [{ items: { $ref: "#/definitions/Entry" } }],
	})
	assert.property(document.definitions, "Entry")
	const registrations = document.definitions.Entry.allOf!
	assert.deepEqual(registrations[0]?.then.properties.config, host)
	assert.include(
		registrations[1]!.if.properties.name.enum,
		invalid[0]!.config.plugins[0]!.name,
	)
	assert.deepEqual(registrations[1]!.then, {
		properties: { config: child },
		required: ["config"],
	})
	assert.equal(child.properties.token.type, "string")
	assert.notTypeOf(invalid[0]!.config.plugins[0]!.config.token, "string")
	assert.deepNestedInclude(document.definitions.Entry, {
		"anyOf[0].properties.id.description":
			"Identifies the entry. Graft adds one, and writes it to the file, if an entry has none.",
	})
})

it("describes the recording role on plugin entries and forbids it on groups", () => {
	const document = ConfigSchema.make()
	assert.deepNestedInclude(document.definitions.Entry, {
		"anyOf[0].properties.recording": { not: {} },
		"anyOf[1].properties.recording.properties.role.type": "string",
		"anyOf[1].properties.recording.properties.scope.items.type": "string",
		"anyOf[1].properties.recording.required": ["role"],
	})
})
