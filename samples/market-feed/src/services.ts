import { Context, Effect, PubSub, Schema, type Scope } from "effect"

/** Ordered BTC-USD quotes; timestamps are milliseconds since the feed started. */
export interface Quote {
	readonly at: number
	readonly price: number
}

export interface Candle {
	readonly minute: number
	readonly open: number
	readonly high: number
	readonly low: number
	readonly close: number
	readonly ticks: number
}

export class ExchangeUnavailable extends Schema.TaggedError<
	ExchangeUnavailable,
	{ readonly brand: unique symbol }
>()("ExchangeUnavailable", {
	operation: Schema.Literals(["connect", "read"]),
	detail: Schema.String,
}) {
	override get message(): string {
		return `${this.operation}: ${this.detail}`
	}
}

export class ExchangeTransport extends Context.Service<
	ExchangeTransport,
	{
		readonly connect: Effect.Effect<
			{ readonly read: Effect.Effect<Quote, ExchangeUnavailable> },
			ExchangeUnavailable,
			Scope.Scope
		>
	}
>()("@graftland/sample-market-feed/services/ExchangeTransport") {}

export class Quotes extends Context.Service<
	Quotes,
	{
		readonly subscribe: Effect.Effect<
			PubSub.Subscription<Quote>,
			never,
			Scope.Scope
		>
	}
>()("@graftland/sample-market-feed/services/Quotes") {}

export class Candles extends Context.Service<
	Candles,
	{
		readonly subscribe: Effect.Effect<
			PubSub.Subscription<Candle>,
			never,
			Scope.Scope
		>
	}
>()("@graftland/sample-market-feed/services/Candles") {}

export class Notifier extends Context.Service<
	Notifier,
	{ readonly send: (message: string) => Effect.Effect<void> }
>()("@graftland/sample-market-feed/services/Notifier") {}
