import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Contract } from "../../src/index"

export const api = RpcGroup.make(
	Contract.operation(
		"@graftland/test/unit/Read",
		1,
		Rpc.make("Read", {
			success: Schema.Struct({ value: Schema.String, probes: Schema.Finite }),
		}),
	),
)
export class Value extends Context.Service<
	Value,
	{
		readonly read: Effect.Effect<{
			readonly value: string
			readonly probes: number
		}>
	}
>()("@graftland/plugin-remote/test/fixtures/unit-contract/Value") {}
export const service = Contract.service(Value, api, {
	toHandlers: (value) => ({ Read: () => value.read }),
	fromClient: (client) => ({ read: client.Read().pipe(Effect.orDie) }),
})
export const config = Schema.Struct({
	value: Schema.String,
	wait: Schema.Boolean,
	hangStop: Schema.Boolean,
})
export const contract = Contract.make({
	name: "expected-name",
	config,
	error: Schema.String,
	provides: [service],
})
