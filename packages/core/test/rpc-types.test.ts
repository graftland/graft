/**
 * `Remote.service` infers handler payloads and the client shape from the
 * service key and the RPC group, so call sites annotate neither.
 */
import { Context, Effect, Schema, Stream } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { assert, describe, it } from "@effect/vitest"

import { Remote } from "../src/rpc/index.ts"

class Pricing extends Context.Service<
	Pricing,
	{
		readonly quote: (
			sku: string,
		) => Effect.Effect<number, Remote.RemoteClientError>
	}
>()("@graftland/graft/test/rpc-types.test/Pricing") {}

const PricingRpcs = RpcGroup.make(
	Rpc.make("Quote", {
		payload: { sku: Schema.String },
		success: Schema.Finite,
	}),
)

/* The design's example, verbatim: no payload annotation anywhere. */
const PricingRemote = Remote.service(Pricing, PricingRpcs, {
	toHandlers: (pricing) => ({ Quote: ({ sku }) => pricing.quote(sku) }),
	fromClient: (client) => ({ quote: (sku) => client.Quote({ sku }) }),
})

class Ticker extends Context.Service<
	Ticker,
	{
		readonly watch: (
			symbol: string,
		) => Stream.Stream<number, Remote.RemoteClientError>
	}
>()("@graftland/graft/test/rpc-types.test/Ticker") {}

const TickerRpcs = RpcGroup.make(
	Rpc.make("Watch", {
		payload: { symbol: Schema.String },
		success: Schema.Finite,
		stream: true,
	}),
)

/* Stream RPCs infer their payload and client shape the same way. */
const TickerRemote = Remote.service(Ticker, TickerRpcs, {
	toHandlers: (ticker) => ({ Watch: ({ symbol }) => ticker.watch(symbol) }),
	fromClient: (client) => ({ watch: (symbol) => client.Watch({ symbol }) }),
})

/* The inferred handler payload is the RPC payload, not `any`. */
Remote.service(Pricing, PricingRpcs, {
	toHandlers: (pricing) => ({
		// @ts-expect-error the handler payload is the Quote payload
		Quote: ({ sku }: { readonly sku: number }) => pricing.quote(sku),
	}),
	fromClient: (client) => ({ quote: (sku) => client.Quote({ sku }) }),
})

/* The generated client rejects a payload of the wrong type. */
Remote.service(Pricing, PricingRpcs, {
	toHandlers: (pricing) => ({ Quote: ({ sku }) => pricing.quote(sku) }),
	fromClient: (client) => ({
		// @ts-expect-error Quote takes a string sku
		quote: (sku: string) => client.Quote({ sku: 1 }),
	}),
})

/* `fromClient` has to produce the service shape. */
Remote.service(Pricing, PricingRpcs, {
	toHandlers: (pricing) => ({ Quote: ({ sku }) => pricing.quote(sku) }),
	// @ts-expect-error the client-facing shape must match the service shape
	fromClient: (client) => ({ quote: (sku: number) => client.Quote({ sku }) }),
})

describe("Remote.service types", () => {
	it("defaults the prefix to the service key", () => {
		assert.strictEqual(PricingRemote.prefix, Pricing.key)
		assert.strictEqual(PricingRemote.key, Pricing)
		assert.strictEqual(PricingRemote.group, PricingRpcs)
		assert.strictEqual(TickerRemote.prefix, Ticker.key)
		assert.strictEqual(TickerRemote.group, TickerRpcs)
	})
})
