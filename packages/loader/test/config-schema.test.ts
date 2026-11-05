import { assert, it } from "@effect/vitest"

import { ConfigSchema } from "../src/index"

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
