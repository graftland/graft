import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Contract } from "@graftland/plugin-remote"

import { config } from "./index.js"

export class Audit extends Context.Service<
	Audit,
	{ readonly record: Effect.Effect<string> }
>()("@example/forecast-contract/audit") {}
export const service = Contract.service(
	Audit,
	RpcGroup.make(
		Contract.operation(
			"@example/audit/Record",
			1,
			Rpc.make("Record", { success: Schema.String }),
		),
	),
	{
		toHandlers: (audit) => ({ Record: () => audit.record }),
		fromClient: (client) => ({ record: client.Record().pipe(Effect.orDie) }),
	},
)
export const contract = Contract.make({
	name: "@example/audit",
	config,
	error: Schema.String,
	provides: [service],
})
