import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Contract } from "@graftland/plugin-remote"

export class GreetingUnavailable extends Schema.TaggedError<
	GreetingUnavailable,
	{ readonly brand: unique symbol }
>()("GreetingUnavailable", { cause: Schema.Defect() }) {}

export class Greeter extends Context.Service<
	Greeter,
	{
		readonly greet: (name: string) => Effect.Effect<string, GreetingUnavailable>
	}
>()("@graftland/sample-remote/contract/Greeter") {}

const api = RpcGroup.make(
	Rpc.make("Greet", {
		payload: { name: Schema.String },
		success: Schema.String,
		error: GreetingUnavailable,
	}),
)
const greeter = Contract.service(Greeter, api, {
	toHandlers: (service) => ({ Greet: ({ name }) => service.greet(name) }),
	fromClient: (client) => ({
		greet: (name) =>
			client
				.Greet({ name })
				.pipe(
					Effect.catchTag("RpcClientError", (cause) =>
						GreetingUnavailable.make({ cause }),
					),
				),
	}),
})
export const config = Schema.Struct({ greeting: Schema.String })
export const contract = Contract.make({
	name: "@graftland/sample-remote/contract",
	config,
	module: new URL("./greeter.js", import.meta.url).href,
	provides: [greeter],
})
