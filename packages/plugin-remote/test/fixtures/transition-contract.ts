import { Context, Effect, Schema, type Scope } from "effect"
import { Rpc, RpcGroup, type RpcClientError } from "effect/rpc"

import { Contract } from "../../src/index"

export const api = RpcGroup.make(
	Contract.operation(
		"@graftland/test/transition/Read",
		1,
		Rpc.make("Read", {
			success: Schema.Struct({
				value: Schema.String,
				held: Schema.Finite,
				finalizing: Schema.Boolean,
			}),
		}),
	),
	Contract.operation(
		"@graftland/test/transition/Hold",
		1,
		Rpc.make("Hold", { success: Schema.String }),
	),
	Contract.operation(
		"@graftland/test/transition/Release",
		1,
		Rpc.make("Release"),
	),
	Contract.operation(
		"@graftland/test/transition/RespondThenBlock",
		1,
		Rpc.make("RespondThenBlock", { success: Schema.String }),
	),
	Contract.operation("@graftland/test/transition/Crash", 1, Rpc.make("Crash")),
)
export class Integration extends Context.Service<
	Integration,
	{
		readonly read: Effect.Effect<
			{
				readonly value: string
				readonly held: number
				readonly finalizing: boolean
			},
			RpcClientError.RpcClientError
		>
		readonly hold: Effect.Effect<string, RpcClientError.RpcClientError>
		readonly release: Effect.Effect<void, RpcClientError.RpcClientError>
		readonly respondThenBlock: Effect.Effect<
			string,
			RpcClientError.RpcClientError,
			Scope.Scope
		>
		readonly crash: Effect.Effect<void, RpcClientError.RpcClientError>
	}
>()("@graftland/plugin-remote/test/fixtures/transition-contract/Integration") {}
export const service = Contract.service(Integration, api, {
	toHandlers: (service) => ({
		Read: () => service.read.pipe(Effect.orDie),
		Hold: () => service.hold.pipe(Effect.orDie),
		Release: () => service.release.pipe(Effect.orDie),
		RespondThenBlock: () => service.respondThenBlock.pipe(Effect.orDie),
		Crash: () => service.crash.pipe(Effect.orDie),
	}),
	fromClient: (client) => ({
		read: client.Read(),
		hold: client.Hold(),
		release: client.Release(),
		respondThenBlock: client.RespondThenBlock(),
		crash: client.Crash(),
	}),
})
export const config = Schema.Struct({
	value: Schema.String,
	release: Schema.optionalKey(Schema.String),
	broken: Schema.optionalKey(
		Schema.Literals(["serve", "ready", "probe", "stop"]),
	),
})
export const contract = Contract.make({
	name: "transition-integration",
	config,
	error: Schema.String,
	provides: [service],
})
