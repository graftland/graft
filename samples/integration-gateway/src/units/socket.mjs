import { createConnection, createServer } from "node:net"

import { Cause, Deferred, Effect, FiberSet, Queue, Ref, Stream } from "effect"

export const channel = Effect.fnUntraced(function* (socket) {
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const queue = yield* Queue.bounded(64)
	const buffer = yield* Ref.make("")
	const receive = Effect.fnUntraced(function* (chunk) {
		const text = (yield* Ref.get(buffer)) + chunk.toString("utf8")
		const parts = text.split("\n")
		yield* Ref.set(buffer, parts.at(-1))
		if (text.length > 1048576)
			return yield* Effect.die("Business frame limit exceeded")
		yield* Effect.forEach(
			parts.slice(0, -1),
			(line) => Queue.offer(queue, line),
			{ discard: true },
		)
		yield* Effect.sync(() => socket.resume())
	})
	socket.on("data", (chunk) => {
		socket.pause()
		run(
			receive(chunk).pipe(
				Effect.catchCause((cause) => Queue.failCause(queue, cause)),
			),
		)
	})
	socket.on("error", (cause) => run(Queue.failCause(queue, Cause.die(cause))))
	socket.on("end", () => run(Queue.end(queue)))
	yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()))
	return {
		socket,
		lines: Stream.fromQueue(queue),
		write: (text) =>
			Effect.callback((resume) => {
				socket.write(text + "\n", (cause) =>
					resume(cause ? Effect.die(cause) : Effect.void),
				)
			}),
	}
})
export const connect = Effect.fnUntraced(function* (port) {
	const ready = yield* Deferred.make()
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const socket = yield* Effect.sync(() =>
		createConnection({ host: "127.0.0.1", port }),
	)
	const connection = yield* channel(socket)
	socket.once("connect", () => run(Deferred.succeed(ready, undefined)))
	socket.once("error", (cause) =>
		run(Deferred.failCause(ready, Cause.die(cause))),
	)
	yield* Deferred.await(ready)
	return connection
})
export const listen = Effect.fnUntraced(function* (accept) {
	const ready = yield* Deferred.make()
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const server = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createServer((socket) =>
				run(
					Effect.scoped(accept(socket)).pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Business connection failed", cause),
						),
					),
				),
			),
		),
		(server) => Effect.sync(() => server.close()),
	)
	server.once("error", (cause) =>
		run(Deferred.failCause(ready, Cause.die(cause))),
	)
	server.listen({ host: "127.0.0.1", port: 0 }, () => {
		const address = server.address()
		run(
			typeof address === "object" && address !== null
				? Deferred.succeed(ready, address.port)
				: Deferred.failCause(ready, Cause.die("Missing listener address")),
		)
	})
	return yield* Deferred.await(ready)
})
