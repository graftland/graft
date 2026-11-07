import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup, type RpcClientError } from "effect/rpc"

import { Contract } from "@graftland/plugin-remote"

export const payload = Schema.Struct({
	mode: Schema.Literals([
		"ok",
		"reject",
		"defect",
		"wait",
		"started",
		"released",
	]),
	text: Schema.String.check(
		Schema.makeFilter((text) =>
			text.length > 0 ? undefined : "Text must not be empty",
		),
	),
})
export class Rejected extends Schema.TaggedError<
	Rejected,
	{ readonly brand: unique symbol }
>()("Rejected", { message: Schema.String }) {}
export class Service extends Context.Service<
	Service,
	{
		readonly execute: (
			input: typeof payload.Type,
		) => Effect.Effect<string, Rejected | RpcClientError.RpcClientError>
	}
>()("@alice/conformance-echo-contract/Service") {}
export const service = Contract.service(
	Service,
	RpcGroup.make(
		Contract.operation(
			"@alice/conformance-echo/Execute",
			1,
			Rpc.make("Execute", { payload, success: Schema.String, error: Rejected }),
		),
	),
	{
		toHandlers: (value) => ({
			Execute: (input) =>
				value
					.execute(input)
					.pipe(Effect.catchTag("RpcClientError", Effect.die)),
		}),
		fromClient: (client) => ({ execute: (input) => client.Execute(input) }),
	},
)
export const contract = Contract.make({
	name: "@alice/conformance-echo",
	config: Schema.Struct({}),
	provides: [service],
})
