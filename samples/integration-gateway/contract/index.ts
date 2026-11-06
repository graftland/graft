import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup, type RpcClientError } from "effect/rpc"

import { Contract } from "@graftland/plugin-remote"

export class Forecast extends Context.Service<
	Forecast,
	{
		readonly get: (
			city: string,
		) => Effect.Effect<string, RpcClientError.RpcClientError>
	}
>()("@example/forecast-contract/Forecast") {}

export const config = Schema.Struct({
	release: Schema.String,
	started: Schema.String,
})
export const service = Contract.service(
	Forecast,
	RpcGroup.make(
		Contract.operation(
			"@example/forecast/Get",
			1,
			Rpc.make("Get", {
				payload: { city: Schema.String },
				success: Schema.String,
			}),
		),
	),
	{
		toHandlers: (forecast) => ({
			Get: ({ city }) => forecast.get(city).pipe(Effect.orDie),
		}),
		fromClient: (client) => ({ get: (city) => client.Get({ city }) }),
	},
)
export const contract = Contract.make({
	name: "@example/forecasts",
	config,
	error: Schema.String,
	provides: [service],
})
