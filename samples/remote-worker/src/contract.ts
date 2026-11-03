import { Contract } from "@graftland/remote"
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export class WorkerUnavailable extends Schema.TaggedError<
	WorkerUnavailable,
	{ readonly brand: unique symbol }
>()("WorkerUnavailable", { cause: Schema.Defect() }) {}

export const Reply = Schema.Struct({ text: Schema.String, pid: Schema.Int })
export class Formatter extends Context.Service<
	Formatter,
	{
		readonly format: (
			text: string,
		) => Effect.Effect<typeof Reply.Type, WorkerUnavailable>
	}
>()("@graftland/sample-remote-worker/contract/Formatter") {}

const api = RpcGroup.make(
	Rpc.make("Format", {
		payload: { text: Schema.String },
		success: Reply,
		error: WorkerUnavailable,
	}),
)
const formatter = Contract.service(Formatter, api, {
	toHandlers: (service) => ({
		Format: ({ text }: { readonly text: string }) => service.format(text),
	}),
	fromClient: (client) => ({
		format: (text) =>
			client
				.Format({ text })
				.pipe(
					Effect.catchTag("RpcClientError", (cause) =>
						WorkerUnavailable.make({ cause }),
					),
				),
	}),
})
export const config = Schema.Struct({ prefix: Schema.String })
export const contract: ReturnType<
	typeof Contract.make<typeof config, typeof Schema.Never>
> = Contract.make({
	name: "remote-worker",
	config,
	error: Schema.Never,
	module: new URL("./worker.js", import.meta.url).href,
	provides: [formatter],
})
