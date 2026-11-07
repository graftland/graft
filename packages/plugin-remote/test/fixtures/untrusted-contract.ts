import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup, type RpcClientError } from "effect/rpc"

import { Capabilities, Contract } from "@graftland/plugin-remote"

export const Request = Schema.Struct({
	action: Schema.Literals([
		"file",
		"environment",
		"http",
		"network",
		"read",
		"pid",
	]),
	value: Schema.String,
})
export type Request = typeof Request.Type
export class Attack extends Context.Service<
	Attack,
	{
		readonly run: (
			request: Request,
		) => Effect.Effect<string, RpcClientError.RpcClientError>
	}
>()("@graftland/plugin-remote/test/fixtures/untrusted-contract/Attack") {}
export const api = RpcGroup.make(
	Contract.operation(
		"@graftland/test/untrusted/run",
		1,
		Rpc.make("Run", { payload: Request, success: Schema.String }),
	),
)
export const service = Contract.service(Attack, api, {
	toHandlers: (value) => ({
		Run: (request) => value.run(request).pipe(Effect.orDie),
	}),
	fromClient: (client) => ({ run: client.Run }),
})
export const contract = Contract.make({
	name: "untrusted-fixture",
	config: Schema.Struct({}),
	inject: [Capabilities.service],
	provides: [service],
})
