import type { Effect, Option } from "effect"
import { Context } from "effect"

export class Forecasts extends Context.Service<
	Forecasts,
	{
		readonly today: (city: string) => Effect.Effect<Option.Option<string>>
	}
>()("@graftland/sample-chat-bot/Forecasts") {}
