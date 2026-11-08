/** Unit-local encoded TCP channels. The kernel sees endpoint metadata only. */
import { createServer, type Socket as NativeSocket } from "node:net"

import { Cause, Effect, FiberSet, Queue, Scope, Sink, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { RpcClient } from "effect/rpc"
import { Socket } from "effect/socket"
import { NodeSocket } from "@effect/platform-node"

import type { Kernel } from "@graftland/graft"

import type * as Contract from "../Contract"
import { TransportError } from "../Errors"
import type { Channel } from "../Transport"
import type { Owner } from "./ownedCalls"
import * as Port from "./port"
import * as Services from "./services"

export interface Provider {
	readonly endpoint: Kernel.Endpoint
	readonly serve: Effect.Effect<never>
}
const channel = Effect.fnUntraced(function* (
	socket: Socket.Socket,
): Effect.fn.Return<Channel, Socket.SocketError, Scope.Scope> {
	const reader = yield* socket.reader
	const writer = yield* socket.writer
	return {
		input: Stream.fromEffectRepeat(reader.pull).pipe(
			Stream.flattenIterable,
			Stream.map((bytes) =>
				typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
			),
			Stream.mapError((cause) =>
				TransportError.make({ cause: Cause.fail(cause) }),
			),
		),
		output: Sink.forEach((bytes: Uint8Array) => writer.write(bytes)).pipe(
			Sink.mapError((cause) =>
				TransportError.make({ cause: Cause.fail(cause) }),
			),
		),
	}
})
const connection = Effect.fnUntraced(function* (
	socket: NativeSocket,
	credential: string,
	services: ReadonlyArray<Contract.Service>,
	owner: Owner,
): Effect.fn.Return<never, Socket.SocketError, Scope.Scope> {
	const adapted = yield* NodeSocket.fromDuplex(Effect.succeed(socket))
	const bytes = yield* channel(adapted)
	const port = yield* Port.make(bytes, {
		session: credential,
		serve: Services.endpoints(services),
		call: {},
	})
	yield* Effect.forEach(
		services,
		(service) => service.serve(port, owner).pipe(Effect.forkScoped),
		{ discard: true },
	)
	return yield* port.await.pipe(Effect.orDie)
})
export const provider = Effect.fnUntraced(function* (
	services: ReadonlyArray<Contract.Service>,
	diagnostic: (cause: Cause.Cause<unknown>) => Effect.Effect<void>,
	owner: Owner,
): Effect.fn.Return<Provider, never, Scope.Scope | SecureRandom.SecureRandom> {
	const random = yield* SecureRandom.SecureRandom
	const credential = yield* random.uuidV4()
	const accepted = yield* Queue.unbounded<NativeSocket>()
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const server = yield* Effect.sync(() =>
		createServer((socket) => run(Queue.offer(accepted, socket))),
	)
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			server.close()
		}),
	)
	yield* Effect.callback<void>((resume) => {
		server.once("error", (cause) => resume(Effect.die(cause)))
		server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.void))
	})
	const address = yield* Effect.sync(() => server.address())
	if (address === null || typeof address === "string")
		return yield* Effect.die("Unit endpoint did not bind a TCP address")
	const serve: Effect.Effect<never> = Queue.take(accepted).pipe(
		Effect.flatMap((socket) =>
			connection(socket, credential, services, owner).pipe(
				Effect.scoped,
				Effect.catchCause(diagnostic),
				Effect.forkScoped,
			),
		),
		Effect.forever,
		Effect.scoped,
	)
	return {
		endpoint: { host: "127.0.0.1", port: address.port, credential },
		serve,
	}
})
export interface Client {
	readonly clientProtocol: (service: string) => RpcClient.Protocol["Service"]
}
export const client = Effect.fnUntraced(function* (
	route: Kernel.BindingRoute,
	services: ReadonlyArray<Contract.Service>,
): Effect.fn.Return<Client, Socket.SocketError, Scope.Scope> {
	const socket = yield* NodeSocket.makeNet({
		host: route.endpoint.host,
		port: route.endpoint.port,
	})
	const bytes = yield* channel(socket)
	return yield* Port.make(bytes, {
		session: route.endpoint.credential,
		serve: {},
		call: Services.endpoints(services),
	})
})
