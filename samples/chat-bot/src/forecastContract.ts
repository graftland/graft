import { Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Contract } from "@graftland/plugin-remote"

import { Forecasts, ForecastUnavailable } from "./Forecasts.ts"

const api = RpcGroup.make(
	Contract.operation(
		"@graftland/sample-chat-bot/Today",
		1,
		Rpc.make("Today", {
			payload: { city: Schema.String },
			success: Schema.Option(Schema.String),
			error: ForecastUnavailable,
		}),
	),
)
const forecasts = Contract.service(Forecasts, api, {
	toHandlers: (service) => ({ Today: ({ city }) => service.today(city) }),
	fromClient: (client) => ({
		today: (city) =>
			client
				.Today({ city })
				.pipe(
					Effect.catchTag("RpcClientError", (cause) =>
						ForecastUnavailable.make({ cause }),
					),
				),
	}),
})
export const config = Schema.Struct({
	units: Schema.Literals(["celsius", "fahrenheit"]),
})
export const contract = Contract.make({
	name: "@graftland/sample-chat-bot/forecastContract/contract",
	config,

	provides: [forecasts],
})
