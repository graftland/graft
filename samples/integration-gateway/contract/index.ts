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
	prefix: Schema.optionalKey(Schema.String),
	unhealthy: Schema.optionalKey(Schema.Boolean),
	holdProbe: Schema.optionalKey(Schema.Boolean),
	credential: Schema.optionalKey(Schema.String),
})
export const Get = Contract.operation(
	"@example/forecast/Get",
	1,
	Rpc.make("Get", {
		payload: { city: Schema.String },
		success: Schema.String,
	}),
)
export const service = Contract.service(Forecast, RpcGroup.make(Get), {
	toHandlers: (forecast) => ({
		Get: ({ city }) => forecast.get(city).pipe(Effect.orDie),
	}),
	fromClient: (client) => ({ get: (city) => client.Get({ city }) }),
})
export const contract = Contract.make({
	name: "@example/forecasts",
	config,
	error: Schema.String,
	provides: [service],
})
