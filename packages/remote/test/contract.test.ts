import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Contract } from "../src/index"

class First extends Context.Service<First, {}>()(
	"@graftland/remote/test/contract.test/First",
) {}
class Second extends Context.Service<Second, {}>()(
	"@graftland/remote/test/contract.test/Second",
) {}

const service = (key: Context.Key<unknown, {}>, tag: string) =>
	Contract.service(key, RpcGroup.make(Rpc.make(tag)), {
		toHandlers: () => ({ [tag]: () => Effect.void }),
		fromClient: () => ({}),
	})
const options = {
	name: "tag-validation",
	module: "unused",
	config: Schema.Struct({}),
	error: Schema.Never,
}
describe("contract tag validation", () => {
	it("rejects duplicate tags across injected service descriptors at definition time", () => {
		assert.throws(
			() =>
				Contract.make({
					...options,
					inject: [service(First, "Shared"), service(Second, "Shared")],
				}),
			"RPC tags must be unique",
		)
	})
	it("rejects duplicate tags across exported service descriptors at definition time", () => {
		assert.throws(
			() =>
				Contract.make({
					...options,
					provides: [service(First, "Shared"), service(Second, "Shared")],
				}),
			"RPC tags must be unique",
		)
	})
	it("rejects every control tag in exported services at definition time", () => {
		for (const tag of ["Load", "Dispose", "Events", "Logs"]) {
			assert.throws(
				() =>
					Contract.make({
						...options,
						provides: [service(First, tag)],
					}),
				"RPC tags must be unique",
			)
		}
	})
	it("allows matching tags in opposite directions", () => {
		assert.doesNotThrow(() =>
			Contract.make({
				...options,
				inject: [service(First, "Shared")],
				provides: [service(Second, "Shared")],
			}),
		)
	})
})
