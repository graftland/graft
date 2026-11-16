/**
 * Reconnect.
 *
 * Remote services mirror the server's availability. When the connection drops,
 * the client withdraws every remote service and calls fail with
 * `RemoteUnavailable`. The connect mount then reconnects on its retry schedule
 * and publishes the services again.
 */
import {
	Context,
	Effect,
	Layer,
	Option,
	Schedule,
	Schema,
	Stream,
} from "effect"
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
>()("@graftland-samples/06-reconnect/program/Pricing") {}

const Quote = Rpc.make("Quote", {
	payload: { sku: Schema.String },
	success: Schema.Finite,
})

const PricingRpcs = RpcGroup.make(Quote)

const pricingRemote = Remote.service(Pricing, PricingRpcs, {
	toHandlers: (pricing) => ({
		Quote: ({ sku }: { readonly sku: string }) => pricing.quote(sku),
	}),
	fromClient: (client) => ({
		quote: (sku) => client.Quote({ sku }),
	}),
})

const pricing = Layer.succeed(Pricing, {
	quote: (sku) => Effect.succeed(sku === "book" ? 12 : 0),
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

/** Waits until the remote service is withdrawn, then until it is published again. */
const reconnect = Effect.gen(function* () {
	yield* Graft.watch(Pricing).pipe(Stream.filter(Option.isNone), Stream.runHead)
	yield* Effect.log(
		"The connection dropped and the remote service was withdrawn",
	)
	yield* Graft.await(Pricing)
	yield* Effect.log(
		"The connection is back and the remote service is published",
	)
})

const client = (testing: Testing.InMemoryProtocol) =>
	withGraph(
		Effect.gen(function* () {
			yield* Remote.connect({
				services: [pricingRemote],
				protocol: testing.client,
				retry: Schedule.exponential("200 millis"),
			})

			yield* Effect.forkScoped(
				Graft.watch(Pricing).pipe(
					Stream.runForEach((value) =>
						Effect.log(
							Option.isSome(value)
								? "The remote service is available"
								: "The remote service is gone",
						),
					),
				),
			)

			const first = yield* Graft.use(Pricing, (service) =>
				service.quote("book"),
			)
			yield* Effect.log(`Before the drop, the book costs ${first}`)

			yield* testing.disconnect
			yield* reconnect

			const second = yield* Graft.use(Pricing, (service) =>
				service.quote("book"),
			)
			yield* Effect.log(`After reconnecting, the book costs ${second}`)
		}),
	)

export const program = Effect.gen(function* () {
	const testing = yield* Testing.make
	yield* Effect.forkScoped(server(testing))
	yield* client(testing)
})
