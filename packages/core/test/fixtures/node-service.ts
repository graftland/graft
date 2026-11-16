/** A counter contract and server program shared by the Node transport fixtures. */
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Rpc, RpcGroup, type RpcServer } from "effect/rpc"

import { Graft } from "../../src/index.ts"
import { Remote } from "../../src/rpc/index.ts"

export class Counter extends Context.Service<
	Counter,
	{ readonly inc: (n: number) => Effect.Effect<number> }
>()("@graftland/graft/test/fixtures/node-service/Counter") {}

export const CounterRpcs = RpcGroup.make(
	Rpc.make("Inc", {
		payload: { n: Schema.Finite },
		success: Schema.Finite,
	}),
)

export const CounterRemote = Remote.service(Counter, CounterRpcs, {
	toHandlers: (counter) => ({
		Inc: ({ n }: { readonly n: number }) => counter.inc(n),
	}),
	fromClient: (client) => ({
		inc: (n: number) => client.Inc({ n }).pipe(Effect.orDie),
	}),
})

/** Serves the counter over the given protocol until the process ends. */
export const serverProgram = <E>(
	protocol: Layer.Layer<RpcServer.Protocol, E>,
) =>
	Effect.gen(function* () {
		const count = yield* Ref.make(0)
		yield* Graft.publish(Counter, {
			inc: (n) => Ref.updateAndGet(count, (current) => current + n),
		})
		const mount = yield* Remote.serve({
			services: [CounterRemote],
			protocol: Layer.orDie(protocol),
		})
		yield* mount.await
		return yield* Effect.never
	}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))
