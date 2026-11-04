/**
 * What the host and the runner share. The host imports this module, never the
 * worker implementation.
 */
import { Contract } from "@graftland/plugin-remote"
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

/** The other side of the connection could not be reached. */
export class Unreachable extends Schema.TaggedError<
	Unreachable,
	{ readonly brand: unique symbol }
>()("Unreachable", { cause: Schema.Defect() }) {}

/** The ledger already accepted a write from a newer generation of the instance. */
export class StaleGeneration extends Schema.TaggedError<
	StaleGeneration,
	{ readonly brand: unique symbol }
>()("StaleGeneration", {
	instance: Schema.String,
	generation: Schema.Int,
	latest: Schema.Int,
}) {}

export const Write = Schema.Struct({
	invoice: Schema.String,
	destination: Schema.String,
	instance: Schema.String,
	generation: Schema.Int,
})
export const Receipt = Schema.Struct({
	invoice: Schema.String,
	generation: Schema.Int,
	pid: Schema.Int,
})
const Failure = Schema.Union([StaleGeneration, Unreachable])

/** Lives on the host. The exporter on the runner writes to it. */
export class Ledger extends Context.Service<
	Ledger,
	{
		readonly append: (
			write: typeof Write.Type,
		) => Effect.Effect<void, StaleGeneration | Unreachable>
	}
>()("@graftland/sample-remote-runner/contract/Ledger") {}

/** Lives on the runner. Host plugins call it. */
export class Exporter extends Context.Service<
	Exporter,
	{
		readonly export: (
			invoice: string,
		) => Effect.Effect<typeof Receipt.Type, StaleGeneration | Unreachable>
	}
>()("@graftland/sample-remote-runner/contract/Exporter") {}

const ledger = Contract.service(
	Ledger,
	RpcGroup.make(Rpc.make("Append", { payload: Write, error: Failure })),
	{
		toHandlers: (service) => ({
			Append: (write: typeof Write.Type) => service.append(write),
		}),
		fromClient: (client) => ({
			append: (write) =>
				client
					.Append(write)
					.pipe(
						Effect.catchTag("RpcClientError", (cause) =>
							Unreachable.make({ cause }),
						),
					),
		}),
	},
)
const exporter = Contract.service(
	Exporter,
	RpcGroup.make(
		Rpc.make("Export", {
			payload: { invoice: Schema.String },
			success: Receipt,
			error: Failure,
		}),
	),
	{
		toHandlers: (service) => ({
			Export: ({ invoice }: { readonly invoice: string }) =>
				service.export(invoice),
		}),
		fromClient: (client) => ({
			export: (invoice) =>
				client
					.Export({ invoice })
					.pipe(
						Effect.catchTag("RpcClientError", (cause) =>
							Unreachable.make({ cause }),
						),
					),
		}),
	},
)

export const config = Schema.Struct({ destination: Schema.String })
export const contract: Contract.Contract<typeof config, typeof Schema.Never> =
	Contract.make({
		name: "invoice-exporter",
		config,
		error: Schema.Never,
		module: new URL("./worker.js", import.meta.url).href,
		inject: [ledger],
		provides: [exporter],
	})
