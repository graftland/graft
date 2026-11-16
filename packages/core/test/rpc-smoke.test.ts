import {
	Context,
	Effect,
	Layer,
	Queue,
	Ref,
	Schedule,
	Schema,
	Scope,
	Stream,
} from "effect"
import {
	Rpc,
	RpcClient,
	RpcGroup,
	RpcMessage,
	RpcSerialization,
	RpcServer,
} from "effect/rpc"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "../src/index.ts"
import { Remote } from "../src/rpc/index.ts"

/**
 * A minimal in-memory transport. Encoded messages are handed to the other side
 * as plain objects; the codec only fills the schema holes, so no serialization
 * is needed.
 */
const makeTransport = Effect.fnUntraced(function* () {
	const toServer = yield* Queue.unbounded<RpcMessage.FromClientEncoded>()
	const fromServer = yield* Queue.unbounded<RpcMessage.FromServerEncoded>()
	const serverProtocol = Layer.effect(
		RpcServer.Protocol,
		RpcServer.Protocol.make(
			Effect.fnUntraced(function* (write) {
				yield* Stream.fromQueue(toServer).pipe(
					Stream.runForEach((message) => write(0, message)),
					Effect.forkScoped,
				)
				return {
					disconnects: yield* Queue.unbounded<number>(),
					send: (_clientId, response) =>
						Queue.offer(fromServer, response).pipe(Effect.asVoid),
					end: () => Effect.void,
					clientIds: Effect.succeed(new Set([0])),
					initialMessage: Effect.succeedNone,
					supportsAck: true,
					supportsTransferables: false,
					supportsSpanPropagation: true,
					supportsNotifications: true,
					codecFor: RpcSerialization.json.codecFor,
				}
			}),
		),
	)
	const clientProtocol: Effect.Effect<
		RpcClient.Protocol["Service"],
		never,
		Scope.Scope
	> = RpcClient.Protocol.make(
		Effect.fnUntraced(function* (write) {
			yield* Stream.fromQueue(fromServer).pipe(
				Stream.runForEach((message) => write(0, message)),
				Effect.forkScoped,
			)
			return {
				send: (_clientId, request) =>
					Queue.offer(toServer, request).pipe(Effect.asVoid),
				supportsAck: true,
				supportsTransferables: false,
				codecFor: RpcSerialization.json.codecFor,
			}
		}),
	)
	return { serverProtocol, clientProtocol }
})

class Counter extends Context.Service<
	Counter,
	{ readonly inc: (n: number) => Effect.Effect<number> }
>()("@graftland/graft/test/rpc-smoke.test/Counter") {}

const CounterRpcs = RpcGroup.make(
	Rpc.make("Inc", {
		payload: { n: Schema.Finite },
		success: Schema.Finite,
	}),
)

const CounterRemote = Remote.service(Counter, CounterRpcs, {
	toHandlers: (counter) => ({
		Inc: ({ n }: { readonly n: number }) => counter.inc(n),
	}),
	fromClient: (client) => ({
		inc: (n: number) => client.Inc({ n }).pipe(Effect.orDie),
	}),
})

const serverProgram = (protocol: Layer.Layer<RpcServer.Protocol>) =>
	Effect.gen(function* () {
		const count = yield* Ref.make(0)
		yield* Graft.publish(Counter, {
			inc: (n) => Ref.updateAndGet(count, (current) => current + n),
		})
		const mount = yield* Remote.serve({
			services: [CounterRemote],
			protocol,
		})
		yield* mount.await
		return yield* Effect.never
	}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

const clientProgram = (
	protocol: Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope>,
) =>
	Effect.gen(function* () {
		const mount = yield* Remote.connect({
			services: [CounterRemote],
			protocol,
			retry: Schedule.exponential("1 millis"),
		})
		yield* mount.await
		const counter = yield* Graft.await(Counter)
		const result = yield* counter.inc(41).pipe(Effect.orDie)
		assert.strictEqual(result, 41)
		yield* mount.unmount
	}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

describe("remote rpc", () => {
	it.effect("publishes a server service on the client", () =>
		Effect.gen(function* () {
			const transport = yield* makeTransport()
			yield* Effect.raceFirst(
				clientProgram(transport.clientProtocol),
				serverProgram(transport.serverProtocol),
			)
		}).pipe(Effect.timeout("5 seconds")),
	)
})
