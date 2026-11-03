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
describe("contract endpoint validation", () => {
	it("rejects duplicate injected service keys at definition time", () => {
		assert.throws(
			() =>
				Contract.make({
					...options,
					inject: [service(First, "Shared"), service(First, "Different")],
				}),
			"Service keys must be unique",
		)
	})
	it("rejects duplicate exported service keys at definition time", () => {
		assert.throws(
			() =>
				Contract.make({
					...options,
					provides: [service(First, "Shared"), service(First, "Different")],
				}),
			"Service keys must be unique",
		)
	})
	it("allows matching RPC and control tags on separate service endpoints", () => {
		for (const tag of ["Load", "Dispose", "Events", "Logs"]) {
			const contract = Contract.make({
				...options,
				provides: [service(First, tag), service(Second, tag)],
			})
			assert.lengthOf(contract.provides, 2)
		}
	})
	it("rejects a service key repeated across directions", () => {
		assert.throws(
			() =>
				Contract.make({
					...options,
					inject: [service(First, "One")],
					provides: [service(First, "Two")],
				}),
			"Service keys must be unique",
		)
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
