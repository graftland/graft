/**
 * Remote services.
 *
 * A contract names a service, its RPC group, and how to map between them. One
 * graph serves the service; another connects to it and publishes the remote
 * version locally. The transport is just an `effect/rpc` Protocol.
 */
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Graft } from "@graftland/graft"
import { Remote } from "@graftland/graft/rpc"
import * as Testing from "@graftland/graft/testing"

class Pricing extends Context.Service<
	Pricing,
	{
		readonly quote: (
			sku: string,
		) => Effect.Effect<number, Remote.RemoteClientError>
	}
>()("@graftland-samples/05-remote/program/Pricing") {}

const Quote = Rpc.make("Quote", {
	payload: { sku: Schema.String },
	success: Schema.Finite,
})

const PricingRpcs = RpcGroup.make(Quote)

/** The same contract is used on both sides of the connection. */
const pricingRemote = Remote.service(Pricing, PricingRpcs, {
	toHandlers: (pricing) => ({
		Quote: ({ sku }: { readonly sku: string }) => pricing.quote(sku),
	}),
	fromClient: (client) => ({
		quote: (sku) => client.Quote({ sku }),
	}),
})

const prices: Record<string, number> = { book: 12, pen: 3 }

const pricing = Layer.succeed(Pricing, {
	quote: (sku) => Effect.succeed(prices[sku] ?? 0),
})

/** Runs an effect in its own Graft graph and scope. */
const withGraph = <A, E, R>(effect: Effect.Effect<A, E, R | Graft.Graft>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(Graft.layer)
			return yield* Effect.provideContext(effect, context)
		}),
	)

const server = (testing: Testing.InMemoryProtocol) =>
	withGraph(
		Effect.gen(function* () {
			const mounted = yield* Graft.mount(pricing, { name: "pricing" })
			yield* mounted.await
			const serving = yield* Remote.serve({
				services: [pricingRemote],
				protocol: testing.server,
			})
			yield* serving.await
			return yield* Effect.never
		}),
	)

const client = (testing: Testing.InMemoryProtocol) =>
	withGraph(
		Effect.gen(function* () {
			yield* Remote.connect({
				services: [pricingRemote],
				protocol: testing.client,
				retry: Schedule.exponential("50 millis"),
			})
			// `use` waits for the service, holds it for the call, and releases it.
			yield* Graft.use(Pricing, (service) =>
				Effect.flatMap(service.quote("book"), (price) =>
					Effect.log(`The book costs ${price}`),
				),
			)
		}),
	)

export const program = Effect.gen(function* () {
	const testing = yield* Testing.make
	yield* Effect.forkScoped(server(testing))
	yield* client(testing)
})
