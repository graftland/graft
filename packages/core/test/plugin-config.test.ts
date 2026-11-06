import { Effect, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { Plugin } from "../src/index"

it("exposes the declared config schema on definitions and spread copies", () => {
	const config = Schema.Struct({ value: Schema.String })
	const plugin = Plugin.make({
		name: "configured",
		config,
		apply: () => Effect.void,
	})
	assert.strictEqual(plugin.config, config)
	assert.strictEqual({ ...plugin }.config, config)
	assert.isUndefined(
		Plugin.make({ name: "plain", apply: () => Effect.void }).config,
	)
})
