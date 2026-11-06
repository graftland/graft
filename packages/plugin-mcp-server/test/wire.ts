import {
	Cause,
	Context,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Queue,
	Sink,
	Stdio,
	Stream,
} from "effect"
import { Socket } from "effect/socket"
import { NodeSocket } from "@effect/platform-node"

import { Graft, Plugin } from "@graftland/graft"

import stdio from "../src/stdio.ts"
import { decode, encode, type Connection } from "../src/Testing.ts"
import unix from "./fixtures/unix.ts"

export const stdioTransport = Effect.gen(function* () {
	const input = yield* Queue.unbounded<Uint8Array, Cause.Done>()
	const output = yield* Queue.unbounded<string | Uint8Array>()
	const closed = yield* Deferred.make<void>()
	const stream = Stream.fromQueue(output).pipe(
		Stream.map((chunk) =>
			typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
		),
		Stream.decodeText(),
		Stream.splitLines,
		Stream.mapEffect((line) => decode(line)),
	)
	const messages = yield* stream.pipe(
		Stream.orDie,
		Stream.toQueue({ capacity: "unbounded" }),
	)
	const stdioLayer = Stdio.layerTest({
		stdin: Stream.fromQueue(input),
		stdout: () =>
			Sink.forEach((chunk: string | Uint8Array) =>
				Queue.offer(output, chunk),
			).pipe(Sink.onExit(() => Deferred.succeed(closed, undefined))),
	})
	const plugin = Plugin.make({
		name: "@graftland/plugin-mcp-server/test/stdio",
		apply: () =>
			Effect.gen(function* () {
				const context = yield* Layer.build(stdioLayer)
				yield* Graft.provide(Stdio.Stdio, Context.get(context, Stdio.Stdio))
				yield* (yield* Graft.plugin(stdio, {})).await
			}),
	})
	const client: Connection = {
		send: (message) =>
			encode(message).pipe(
				Effect.orDie,
				Effect.flatMap((frame) =>
					Queue.offer(input, new TextEncoder().encode(frame + "\n")),
				),
				Effect.asVoid,
			),
		receive: Queue.take(messages).pipe(Effect.orDie),
		end: Effect.asVoid(Queue.end(input)),
		closed: Deferred.await(closed),
	}
	return { plugin, client: Effect.succeed(client) }
})

export const unixConnection = (path: string) =>
	Effect.gen(function* () {
		const socket = yield* NodeSocket.makeNet({ path })
		const reader = yield* socket.reader
		const writer = yield* socket.writer
		const closed = yield* Deferred.make<void>()
		const output = yield* Queue.unbounded<string | Uint8Array>()
		yield* reader.pull.pipe(
			Effect.flatMap((chunks) =>
				Effect.forEach(chunks, (chunk) => Queue.offer(output, chunk), {
					discard: true,
				}),
			),
			Effect.forever,
			Effect.catchTag("SocketError", (error) =>
				error.reason._tag === "SocketCloseError" && error.reason.code === 1000
					? Effect.void
					: Effect.fail(error),
			),
			Effect.catchCause((cause) =>
				Effect.gen(function* () {
					if (!Cause.hasInterruptsOnly(cause)) yield* Effect.logError(cause)
				}),
			),
			Effect.onExit(() => Deferred.succeed(closed, undefined)),
			Effect.forkScoped,
		)
		const messages = yield* Stream.fromQueue(output).pipe(
			Stream.map((chunk) =>
				typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
			),
			Stream.decodeText(),
			Stream.splitLines,
			Stream.mapEffect((line) => decode(line)),
			Stream.orDie,
			Stream.toQueue({ capacity: "unbounded" }),
		)
		const connection: Connection = {
			send: (message) =>
				encode(message).pipe(
					Effect.orDie,
					Effect.flatMap((frame) => writer.write(frame + "\n")),
					Effect.orDie,
					Effect.asVoid,
				),
			receive: Queue.take(messages).pipe(Effect.orDie),
			end: writer
				.write(new Socket.CloseEvent())
				.pipe(Effect.orDie, Effect.asVoid),
			closed: Deferred.await(closed),
		}
		return connection
	})

export const unixTransport = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mcp-" })
	const path = directory + "/server.sock"
	const plugin = Plugin.make({
		name: "test/unix",
		apply: () =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(unix, { path })).await
			}),
	})
	return { plugin, client: unixConnection(path).pipe(Effect.orDie) }
})
