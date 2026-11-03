import { Context, Effect, Schema, Stream } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Contract } from "../../src/index"

export class HostApi extends Context.Service<
	HostApi,
	{
		readonly double: (value: number) => Effect.Effect<number>
	}
>()("@graftland/remote/test/fixtures/services-contract/HostApi") {}
export const Reply = Schema.Struct({
	value: Schema.Int,
	pid: Schema.Int,
	id: Schema.String,
	generation: Schema.Int,
})
export class ChildApi extends Context.Service<
	ChildApi,
	{
		readonly call: (value: number) => Effect.Effect<typeof Reply.Type>
		readonly values: Stream.Stream<number>
		readonly hold: Effect.Effect<void>
	}
>()("@graftland/remote/test/fixtures/services-contract/ChildApi") {}
const HostRpc = RpcGroup.make(
	Rpc.make("Double", { payload: { value: Schema.Int }, success: Schema.Int }),
)
const ChildRpc = RpcGroup.make(
	Rpc.make("Call", { payload: { value: Schema.Int }, success: Reply }),
	Rpc.make("Values", { success: Schema.Int, stream: true }),
	Rpc.make("Hold"),
)
export const hostService = Contract.service(HostApi, HostRpc, {
	toHandlers: (value) => ({
		Double: ({ value: n }: { readonly value: number }) => value.double(n),
	}),
	// This fixture's explicit policy treats transport failures as defects.
	fromClient: (client) => ({
		double: (value) => client.Double({ value }).pipe(Effect.orDie),
	}),
})
export const childService = Contract.service(ChildApi, ChildRpc, {
	toHandlers: (value) => ({
		Call: ({ value: n }: { readonly value: number }) => value.call(n),
		Values: () => value.values,
		Hold: () => value.hold,
	}),
	fromClient: (client) => ({
		call: (value) => client.Call({ value }).pipe(Effect.orDie),
		values: client.Values().pipe(Stream.orDie),
		hold: client.Hold().pipe(Effect.orDie),
	}),
})
export const config = Schema.Struct({
	directory: Schema.String,
	fail: Schema.Boolean,
})
export const contract = Contract.make({
	name: "service-fixture",
	config,
	error: Schema.String,
	module: new URL("./services-plugin.js", import.meta.url).href,
	inject: [hostService],
	provides: [childService],
})
