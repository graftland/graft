import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Contract } from "../../src/index"

export const input = Schema.Struct({
	mode: Schema.Literals(["ok", "wait", "started", "released"]),
})
export interface Reader {
	readonly read: (value: typeof input.Type) => Effect.Effect<string>
}
export class A extends Context.Service<A, Reader>()(
	"@graftland/plugin-remote/test/fixtures/conformance-contract/A",
) {}
export class B extends Context.Service<B, Reader>()(
	"@graftland/plugin-remote/test/fixtures/conformance-contract/B",
) {}
const group = RpcGroup.make(
	Contract.operation(
		"shared/read",
		1,
		Rpc.make("Read", {
			payload: input,
			success: Schema.String,
		}),
	),
)
const service = <I>(key: Context.Key<I, Reader>) =>
	Contract.service(key, group, {
		toHandlers: (reader) => ({ Read: reader.read }),
		fromClient: (client) => ({
			read: (value) => client.Read(value).pipe(Effect.orDie),
		}),
	})
export const serviceA = service(A)
export const serviceB = service(B)
export const config = Schema.Struct({ broken: Schema.Boolean })
export const contract = Contract.make({
	name: "two-services",
	config,
	provides: [serviceA, serviceB],
})
