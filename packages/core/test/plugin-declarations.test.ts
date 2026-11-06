import { Context, Effect, Layer } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Plugin } from "../src/index"

class Value extends Context.Service<Value, string>()(
	"@graftland/graft/test/plugin-declarations.test/Value",
) {}

const contract: Plugin.ProvidedContract = {
	key: Value,
	operations: [
		Plugin.OperationIdentity.make({ name: "@acme/value/read", version: 1 }),
	],
}

describe("implementation declarations", () => {
	it("keeps declarations inert and defaults overlap to false", () => {
		const plugin = Plugin.make({
			name: "plain",
			apply: () => {
				throw new Error("Must not run during definition")
			},
		})
		assert.deepEqual(plugin.provides, [])
		assert.isFalse(plugin.overlap)
	})
	it("accepts structural contracts and local keys without a transport dependency", () => {
		const plugin = Plugin.make({
			name: "declared",
			provides: [contract, Value],
			overlap: true,
			apply: () => Effect.void,
		})
		assert.deepEqual(plugin.provides, [contract, Value])
		assert.isTrue(plugin.overlap)
	})
	it("retains declarations for configured implementations", () => {
		const plugin = Plugin.make({
			name: "configured",
			config: Plugin.OperationIdentity,
			provides: [contract],
			overlap: true,
			apply: () => Effect.void,
		})
		assert.deepEqual(plugin.provides, [contract])
		assert.isTrue(plugin.overlap)
	})
	it("declares service and layer exports", () => {
		const service = Plugin.service(Value, Effect.succeed("value"), {
			name: "service",
		})
		const layer = Plugin.layer(Layer.succeed(Value, "value"), {
			name: "layer",
			provides: [Value],
			overlap: true,
		})
		assert.deepEqual(service.provides, [Value])
		assert.deepEqual(layer.provides, [Value])
		assert.isTrue(layer.overlap)
	})
})
