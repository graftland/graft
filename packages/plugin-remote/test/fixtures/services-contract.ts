import { Context, Effect, Schema, Stream } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Contract } from "../../src/index"

export class HostApi extends Context.Service<
	HostApi,
	{
		readonly double: (value: number) => Effect.Effect<number>
	}
>()("@graftland/plugin-remote/test/fixtures/services-contract/HostApi") {}
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
>()("@graftland/plugin-remote/test/fixtures/services-contract/ChildApi") {}
const HostRpc = RpcGroup.make(
	Contract.operation(
		"@graftland/test/services-contract/Double",
		1,
		Rpc.make("Double", { payload: { value: Schema.Int }, success: Schema.Int }),
	),
)
const ChildRpc = RpcGroup.make(
	Contract.operation(
		"@graftland/test/services-contract/Load",
		1,
		Rpc.make("Load", { payload: { value: Schema.Int }, success: Reply }),
	),
	Contract.operation(
		"@graftland/test/services-contract/Values",
		1,
		Rpc.make("Values", { success: Schema.Int, stream: true }),
	),
	Contract.operation(
		"@graftland/test/services-contract/Hold",
		1,
		Rpc.make("Hold"),
	),
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
		Load: ({ value: n }: { readonly value: number }) => value.call(n),
		Values: () => value.values,
		Hold: () => value.hold,
	}),
	fromClient: (client) => ({
		call: (value) => client.Load({ value }).pipe(Effect.orDie),
		values: client.Values().pipe(Stream.orDie),
		hold: client.Hold().pipe(Effect.orDie),
	}),
})
// Both exports deliberately share a tag with each other and with Control.
export class ChildLabel extends Context.Service<
	ChildLabel,
	{ readonly read: Effect.Effect<string> }
>()("@graftland/plugin-remote/test/fixtures/services-contract/ChildLabel") {}
const LabelRpc = RpcGroup.make(
	Contract.operation(
		"@graftland/test/services-contract/Label",
		1,
		Rpc.make("Load", { success: Schema.String }),
	),
)
const labelService = Contract.service(ChildLabel, LabelRpc, {
	toHandlers: (value) => ({ Load: () => value.read }),
	fromClient: (client) => ({ read: client.Load().pipe(Effect.orDie) }),
})
export const config = Schema.Struct({
	directory: Schema.String,
	fail: Schema.Boolean,
})
export const contract = Contract.make({
	name: "service-fixture",
	config,
	error: Schema.String,

	inject: [hostService],
	provides: [childService, labelService],
})
