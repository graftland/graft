import { Cause, Effect } from "effect"
// This test proxy abruptly cuts both TCP endpoints to simulate a network partition.
import { createServer, connect, type Socket } from "node:net"
import { TransportError } from "../src/Errors"

export const tcpProxy = (port: number) =>
	Effect.acquireRelease(
		Effect.callback<
			{
				readonly port: number
				readonly disconnect: Effect.Effect<void>
				readonly close: Effect.Effect<void>
			},
			TransportError
		>((resume) => {
			// Native sockets are identity-based resources owned by this test scope.
			const sockets = new Set<Socket>()
			const server = createServer((left) => {
				const right = connect({ host: "127.0.0.1", port })
				sockets.add(left)
				sockets.add(right)
				for (const socket of [left, right]) {
					socket.on("error", () => {
						left.destroy()
						right.destroy()
					})
					socket.on("close", () => sockets.delete(socket))
				}
				left.pipe(right)
				right.pipe(left)
			})
			const disconnect = Effect.sync(() => {
				for (const socket of sockets) socket.destroy()
			})
			const close = disconnect.pipe(
				Effect.andThen(
					Effect.callback<void>((done) => {
						server.close(() => done(Effect.void))
					}),
				),
			)
			server.on("error", (error) =>
				resume(Effect.fail(TransportError.make({ cause: Cause.die(error) }))),
			)
			server.listen(0, "127.0.0.1", () => {
				const address = server.address()
				if (address === null || typeof address === "string")
					resume(
						Effect.fail(
							TransportError.make({
								cause: Cause.die(new Error("Expected a TCP address")),
							}),
						),
					)
				else resume(Effect.succeed({ port: address.port, disconnect, close }))
			})
			return close
		}),
		(proxy) => proxy.close,
	)
