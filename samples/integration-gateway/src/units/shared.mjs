import { Context, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import * as Contract from "@graftland/plugin-remote/Contract"

export class Integration extends Context.Service()("gateway/Integration") {}
export const Config = Schema.Struct({ upstream: Schema.Int, gate: Schema.Int })
export const Service = Contract.service(
	Integration,
	RpcGroup.make(
		Contract.operation(
			"gateway/read",
			1,
			Rpc.make("Read", {
				payload: { city: Schema.String },
				success: Schema.Struct({ version: Schema.Int, term: Schema.Int }),
			}),
		),
	),
	{
		toHandlers: (service) => ({ Read: ({ city }) => service.read(city) }),
		fromClient: (client) => ({ read: (city) => client.Read({ city }) }),
	},
)
