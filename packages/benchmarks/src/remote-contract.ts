import { Context, Effect, Schema, Stream } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Contract } from "@graftland/plugin-remote"

export const Config = Schema.Struct({ value: Schema.Int })
export const Reply = Schema.Struct({
	text: Schema.String,
	sequence: Schema.Int,
	value: Schema.Int,
})
export const Info = Schema.Struct({
	pid: Schema.Int,
	threadId: Schema.Int,
	heap: Schema.Finite,
	rss: Schema.Finite,
	calls: Schema.Int,
	value: Schema.Int,
})
export class Signals extends Context.Service<
	Signals,
	{
		readonly notice: (kind: string) => Effect.Effect<void>
	}
>()("@graftland/benchmarks/remote-contract/Signals") {}
export class Api extends Context.Service<
	Api,
	{
		readonly echo: (text: string) => Effect.Effect<typeof Reply.Type>
		readonly batch: (
			texts: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyArray<typeof Reply.Type>>
		readonly info: Effect.Effect<typeof Info.Type>
		readonly values: (count: number) => Stream.Stream<number>
		readonly burn: (iterations: number) => Effect.Effect<number>
		readonly logs: (count: number, paced: boolean) => Effect.Effect<number>
		readonly crash: Effect.Effect<void>
	}
>()("@graftland/benchmarks/remote-contract/Api") {}
const signals = Contract.service(
	Signals,
	RpcGroup.make(
		Contract.operation(
			"@graftland/benchmarks/remote/Notice",
			1,
			Rpc.make("Notice", { payload: { kind: Schema.String } }),
		),
	),
	{
		toHandlers: (service) => ({
			Notice: ({ kind }: { readonly kind: string }) => service.notice(kind),
		}),
		// Infrastructure faults remain defects with their full cause; benchmark boundaries capture Exit.
		fromClient: (client) => ({
			notice: (kind) => client.Notice({ kind }).pipe(Effect.orDie),
		}),
	},
)
const api = Contract.service(
	Api,
	RpcGroup.make(
		Contract.operation(
			"@graftland/benchmarks/remote/Echo",
			1,
			Rpc.make("Echo", { payload: { text: Schema.String }, success: Reply }),
		),
		Contract.operation(
			"@graftland/benchmarks/remote/Batch",
			1,
			Rpc.make("Batch", {
				payload: { texts: Schema.Array(Schema.String) },
				success: Schema.Array(Reply),
			}),
		),
		Contract.operation(
			"@graftland/benchmarks/remote/Info",
			1,
			Rpc.make("Info", { success: Info }),
		),
		Contract.operation(
			"@graftland/benchmarks/remote/Values",
			1,
			Rpc.make("Values", {
				payload: { count: Schema.Int },
				success: Schema.Int,
				stream: true,
			}),
		),
		Contract.operation(
			"@graftland/benchmarks/remote/Burn",
			1,
			Rpc.make("Burn", {
				payload: { iterations: Schema.Int },
				success: Schema.Int,
			}),
		),
		Contract.operation(
			"@graftland/benchmarks/remote/Logs",
			1,
			Rpc.make("Logs", {
				payload: { count: Schema.Int, paced: Schema.Boolean },
				success: Schema.Int,
			}),
		),
		Contract.operation(
			"@graftland/benchmarks/remote/Crash",
			1,
			Rpc.make("Crash"),
		),
	),
	{
		toHandlers: (service) => ({
			Echo: ({ text }: { readonly text: string }) => service.echo(text),
			Info: () => service.info,
			Batch: ({ texts }: { readonly texts: ReadonlyArray<string> }) =>
				service.batch(texts),
			Values: ({ count }: { readonly count: number }) => service.values(count),
			Burn: ({ iterations }: { readonly iterations: number }) =>
				service.burn(iterations),
			Logs: ({
				count,
				paced,
			}: {
				readonly count: number
				readonly paced: boolean
			}) => service.logs(count, paced),
			Crash: () => service.crash,
		}),
		fromClient: (client) => ({
			echo: (text) => client.Echo({ text }).pipe(Effect.orDie),
			info: client.Info().pipe(Effect.orDie),
			batch: (texts) => client.Batch({ texts }).pipe(Effect.orDie),
			values: (count) => client.Values({ count }).pipe(Stream.orDie),
			burn: (iterations) => client.Burn({ iterations }).pipe(Effect.orDie),
			logs: (count, paced) => client.Logs({ count, paced }).pipe(Effect.orDie),
			crash: client.Crash().pipe(Effect.orDie),
		}),
	},
)
export const contract = Contract.make({
	name: "benchmark-remote",
	config: Config,
	inject: [signals],
	provides: [api],
})
