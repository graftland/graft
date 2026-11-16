/**
 * `Remote` over a real TCP socket.
 *
 * The server listens on `127.0.0.1` through `@effect/platform-node`'s socket
 * server, and the client dials it with a Node net socket. Each side runs a
 * graph of its own, the way two processes would: the server graph holds the
 * local implementation and the served protocol, and the client graph
 * publishes whatever the server currently offers.
 *
 * These tests run on the real clock, because they go through the operating
 * system's network stack.
 */
import * as Net from "node:net"

import {
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Schedule,
	Schema,
	Scope,
	Stream,
} from "effect"
import {
	Rpc,
	RpcClient,
	RpcGroup,
	RpcSerialization,
	RpcServer,
} from "effect/rpc"
import type { SocketServer } from "effect/socket"
import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "../src/index.ts"
import { Remote } from "../src/rpc/index.ts"

const HOST = "127.0.0.1"

class Pricing extends Context.Service<
	Pricing,
	{
		readonly quote: (
			sku: string,
		) => Effect.Effect<number, Remote.RemoteClientError>
	}
>()("@graftland/graft/test/rpc-socket.test/Pricing") {}

const Quote = Rpc.make("Quote", {
	payload: { sku: Schema.String },
	success: Schema.Finite,
})

/**
 * The handler answers from the instance in the graph. `ServerService` drops
 * the transport errors, so an implementation failure is a server defect.
 */
const PricingRemote = Remote.service(Pricing, RpcGroup.make(Quote), {
	toHandlers: (pricing) => ({
		Quote: (payload: { readonly sku: string }) => pricing.quote(payload.sku),
	}),
	fromClient: (client) => ({ quote: (sku) => client.Quote({ sku }) }),
})

const PRICES: Record<string, number> = { abc: 3, xyz: 12 }

/** The server's implementation: `slow` stays in flight until it is interrupted. */
const pricing: { readonly quote: (sku: string) => Effect.Effect<number> } = {
	quote: (sku) =>
		sku === "slow"
			? Effect.sleep("5 seconds").pipe(Effect.as(-1))
			: Effect.succeed(PRICES[sku] ?? -1),
}

/** A free ephemeral port on the loopback interface. */
const freePort: Effect.Effect<number, Error> = Effect.callback<number, Error>(
	(resume) => {
		const probe = Net.createServer()
		probe.once("error", (cause) => resume(Effect.fail(cause)))
		probe.listen(0, HOST, () => {
			const address = probe.address()
			probe.close(() => {
				if (typeof address !== "object" || address === null)
					return resume(Effect.die(new Error("The probe server bound no port")))
				resume(Effect.succeed(address.port))
			})
		})
	},
)

/**
 * The server protocol: an `RpcServer` protocol over a Node TCP socket server
 * bound to `port`. The socket server belongs to the protocol layer, so
 * unmounting the layer that built it closes the listener and its connections.
 */
const serveProtocol = (
	port: number,
): Layer.Layer<RpcServer.Protocol, SocketServer.SocketServerError> =>
	RpcServer.layerProtocolSocketServer.pipe(
		Layer.provide(
			Layer.merge(
				NodeSocketServer.layer({ host: HOST, port }),
				RpcSerialization.layerNdjson,
			),
		),
	)

/** The client protocol: a fresh Node TCP connection, built on every attempt. */
const connectProtocol = (port: number) =>
	Effect.provide(
		RpcClient.makeProtocolSocket(),
		Layer.merge(
			NodeSocket.layerNet({ host: HOST, port }),
			RpcSerialization.layerNdjson,
		),
	)

/** One independent graph, with a `run` that evaluates effects inside it. */
interface Graph {
	readonly run: <A, E>(
		effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
	) => Effect.Effect<A, E>
}

/** Acquires a graph of its own; the test scope tears it down. */
const graph: Effect.Effect<Graph, never, Scope.Scope> = Effect.gen(
	function* () {
		const scope = yield* Scope.make()
		yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
		// One graph per `graph`: every `run` sees the same runtime.
		const context = yield* Scope.provide(
			Layer.build(Layer.fresh(Graft.layer)),
			scope,
		)
		return {
			run: <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
				Scope.provide(Effect.provide(effect, context), scope),
		}
	},
)

/** Waits until the availability of a key satisfies the predicate. */
const until = <I, S>(
	key: Context.Key<I, S>,
	predicate: (value: Option.Option<S>) => boolean,
): Effect.Effect<void, never, Graft.Graft> =>
	Graft.watch(key).pipe(
		Stream.filter(predicate),
		Stream.take(1),
		Stream.runDrain,
	)

/** Whether the exit's failure carries a typed error with the given tag. */
const failedWith = <A, E>(exit: Exit.Exit<A, E>, tag: string): boolean => {
	if (!Exit.isFailure(exit)) return false
	const error = Cause.findErrorOption(exit.cause)
	return Option.exists(
		error,
		(error) => (error as { readonly _tag?: string })._tag === tag,
	)
}

/**
 * A server graph with a local implementation and a served protocol on a free
 * port, and a client graph connected to it.
 */
const session = Effect.gen(function* () {
	const port = yield* freePort
	const server = yield* graph
	const client = yield* graph

	const local = yield* server.run(Graft.mount(Layer.succeed(Pricing, pricing)))
	yield* local.await

	/** Serves on the same port, and waits until the listener is up. */
	const serve = () =>
		server
			.run(
				Remote.serve({
					services: [PricingRemote],
					protocol: serveProtocol(port),
				}),
			)
			.pipe(Effect.tap((serving) => serving.await))

	const serving = yield* serve()

	yield* client.run(
		Remote.connect({
			services: [PricingRemote],
			protocol: connectProtocol(port),
			retry: Schedule.exponential("50 millis"),
		}),
	)
	yield* client.run(until(Pricing, Option.isSome))

	return { client, serving, serve }
})

const quote = (client: Graph, sku: string) =>
	client.run(Graft.use(Pricing, (pricing) => pricing.quote(sku)))

/** Waits for the remote service to come back, reporting a timeout as `false`. */
const available = (client: Graph) =>
	client
		.run(until(Pricing, Option.isSome))
		.pipe(
			Effect.as(true),
			Effect.timeoutOption("5 seconds"),
			Effect.map(Option.getOrElse(() => false)),
		)

describe("remote services over a TCP socket", () => {
	it.live(
		"round trips calls to the remote service",
		() =>
			Effect.gen(function* () {
				const { client } = yield* session

				const first = yield* quote(client, "abc")
				const second = yield* quote(client, "xyz")
				const unknown = yield* quote(client, "missing")

				assert.strictEqual(first, 3)
				assert.strictEqual(second, 12)
				assert.strictEqual(unknown, -1)
			}).pipe(Effect.timeout("10 seconds")),
		20000,
	)

	it.live(
		"fails calls in flight and withdraws the service when the server closes",
		() =>
			Effect.gen(function* () {
				const { client, serving } = yield* session

				const call = yield* client.run(
					Effect.forkScoped(
						Graft.use(Pricing, (pricing) => pricing.quote("slow")),
					),
				)
				yield* Effect.sleep("250 millis")

				yield* serving.unmount

				const exit = yield* Fiber.await(call)
				assert.isTrue(
					failedWith(exit, "RemoteUnavailable"),
					"the in-flight call failed with RemoteUnavailable",
				)
				yield* client.run(until(Pricing, Option.isNone))
			}).pipe(Effect.timeout("10 seconds")),
		20000,
	)

	it.live(
		"reconnects once the server comes back and serves calls again",
		() =>
			Effect.gen(function* () {
				const { client, serving, serve } = yield* session

				yield* serving.unmount
				yield* client.run(until(Pricing, Option.isNone))

				yield* serve()

				const back = yield* available(client)
				assert.isTrue(
					back,
					"the remote service came back after the server restarted",
				)

				const after = yield* quote(client, "abc")
				assert.strictEqual(after, 3)
			}).pipe(Effect.timeout("10 seconds")),
		20000,
	)
})
