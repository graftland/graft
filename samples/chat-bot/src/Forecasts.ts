import type { Effect, Option } from "effect"
import { Context, Schema } from "effect"

export class ForecastUnavailable extends Schema.TaggedError<
	ForecastUnavailable,
	{ readonly brand: unique symbol }
>()("ForecastUnavailable", { cause: Schema.Defect() }) {}

export class Forecasts extends Context.Service<
	Forecasts,
	{
		readonly today: (
			city: string,
		) => Effect.Effect<Option.Option<string>, ForecastUnavailable>
	}
>()("@graftland/sample-chat-bot/Forecasts") {}
