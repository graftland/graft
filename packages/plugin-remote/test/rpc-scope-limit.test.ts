/** Effect-only evidence for the public RpcServer request-Scope limit. */
import { Deferred, Effect, Fiber, Queue, Schema } from "effect"
import {
	Rpc,
	RpcClient,
	RpcGroup,
	RpcMessage,
	RpcSerialization,
	RpcServer,
} from "effect/rpc"
import { assert, it } from "@effect/vitest"

const Group = RpcGroup.make(Rpc.make("Call", { success: Schema.Int }))
const connected = Effect.fnUntraced(function* (
	kind: "scope" | "ensuring" | "result",
) {
	const requests = yield* Queue.unbounded<RpcMessage.FromClientEncoded>()
	const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>()
	const started = yield* Deferred.make<void>()
	const closing = yield* Deferred.make<void>()
	const release = yield* Deferred.make<void>()
	const finished = yield* Deferred.make<void>()
	const rpcExit = yield* Deferred.make<void>()
	const cleanup = Deferred.succeed(closing, undefined).pipe(
		Effect.andThen(Deferred.await(release)),
		Effect.andThen(Deferred.succeed(finished, undefined)),
	)
	const server = RpcServer.Protocol.of({
		run: (f) =>
			Queue.take(requests).pipe(
				Effect.flatMap((message) => f(0, message)),
				Effect.forever,
			),
		disconnects: yield* Queue.unbounded<number>(),
		send: (_, message) =>
			Queue.offer(responses, message).pipe(
				Effect.andThen(
					message._tag === "Exit"
						? Deferred.succeed(rpcExit, undefined)
						: Effect.void,
				),
				Effect.asVoid,
			),
		end: () => Effect.void,
		clientIds: Effect.succeed(new Set([0])),
		initialMessage: Effect.succeedNone,
		supportsAck: true,
		supportsTransferables: false,
		supportsSpanPropagation: false,
		supportsNotifications: false,
		codecFor: RpcSerialization.json.codecFor,
	})
	const handlers = Group.toLayer({
		Call: () =>
			Effect.gen(function* () {
				yield* Deferred.succeed(started, undefined)
				if (kind === "ensuring")
					return yield* Effect.never.pipe(Effect.ensuring(cleanup))
				yield* Effect.addFinalizer(() => cleanup)
				return kind === "result" ? 1 : yield* Effect.never
			}),
	})
	yield* RpcServer.make(Group, { disableTracing: true }).pipe(
		Effect.provide(handlers),
		Effect.provideService(RpcServer.Protocol, server),
		Effect.forkScoped,
	)
	const protocol = RpcClient.Protocol.of({
		run: (_, receive) =>
			Queue.take(responses).pipe(Effect.flatMap(receive), Effect.forever),
		send: (_, message) => Queue.offer(requests, message).pipe(Effect.asVoid),
		supportsAck: true,
		supportsTransferables: false,
		codecFor: RpcSerialization.json.codecFor,
	})
	const client = yield* RpcClient.make(Group, { disableTracing: true }).pipe(
		Effect.provideService(RpcClient.Protocol, protocol),
	)
	return {
		client,
		started: Deferred.await(started),
		closing: Deferred.await(closing),
		finish: Deferred.await(finished),
		finished: Deferred.isDone(finished),
		rpcExit: Deferred.await(rpcExit),
		exitSent: Deferred.isDone(rpcExit),
		release: Deferred.succeed(release, undefined),
	}
})
it.effect(
	"Effect RPC returns a unary result before its private request Scope closes",
	() =>
		Effect.gen(function* () {
			const c = yield* connected("result")
			const value = yield* c.client.Call()
			assert.equal(value, 1)
			yield* c.closing
			const finished = yield* c.finished
			assert.isFalse(finished)
			yield* c.release
			yield* c.finish
		}).pipe(Effect.scoped),
)
it.effect(
	"Effect RPC sends Exit before a cancelled private request Scope finalizer finishes",
	() =>
		Effect.gen(function* () {
			const c = yield* connected("scope")
			const call = yield* c.client.Call().pipe(Effect.exit, Effect.forkScoped)
			yield* c.started
			yield* Fiber.interrupt(call)
			yield* c.closing
			yield* c.rpcExit
			const finished = yield* c.finished
			assert.isFalse(finished)
			yield* c.release
			yield* c.finish
		}).pipe(Effect.scoped),
)
it.effect(
	"Effect RPC interruption does not await a provider ensuring finalizer",
	() =>
		Effect.gen(function* () {
			const c = yield* connected("ensuring")
			const call = yield* c.client.Call().pipe(Effect.exit, Effect.forkScoped)
			yield* c.started
			yield* Fiber.interrupt(call)
			yield* c.closing
			const exitSent = yield* c.exitSent
			assert.isFalse(exitSent)
			yield* c.release
			yield* c.rpcExit
		}).pipe(Effect.scoped),
)
