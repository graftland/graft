import { Context, Schema, type Effect, type Option } from "effect"

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
