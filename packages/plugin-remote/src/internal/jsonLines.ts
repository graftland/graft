/** Fixed, bounded framing for runner control. Business payloads never use this channel. */
import type { Socket } from "node:net"

import {
	Array,
	Cause,
	Effect,
	FiberSet,
	Option,
	Queue,
	Schema,
	Stream,
	String,
} from "effect"

export class ConnectionEnded extends Schema.TaggedError<
	ConnectionEnded,
	{ readonly brand: unique symbol }
>()("ConnectionEnded", {
	reason: Schema.Literals(["Closed", "SocketError", "FrameLimit", "Truncated"]),
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}
type Chunk =
	| { readonly _tag: "Data"; readonly value: string }
	| {
			readonly _tag: "Closed"
			readonly reason: "Closed" | "SocketError"
			readonly cause: Cause.Cause<unknown>
	  }
const limit = 1024 * 1024
const pull = Effect.fnUntraced(function* (
	queue: Queue.Queue<Chunk>,
	remainder: string,
): Effect.fn.Return<readonly [ReadonlyArray<string>, string], ConnectionEnded> {
	const chunk = yield* Queue.take(queue)
	if (chunk._tag === "Closed")
		return yield* ConnectionEnded.make({
			reason:
				chunk.reason === "Closed" && remainder.length > 0
					? "Truncated"
					: chunk.reason,
			cause: chunk.cause,
		})
	const value = remainder + chunk.value
	if (new TextEncoder().encode(value).byteLength > limit)
		return yield* ConnectionEnded.make({
			reason: "FrameLimit",
			cause: Cause.fail("Runner control frame exceeds its byte limit"),
		})
	const parts = String.split(value, "\n")
	return [
		Array.dropRight(parts, 1),
		Option.getOrElse(Array.last(parts), () => ""),
	]
})
export const receive = Effect.fnUntraced(function* (socket: Socket) {
	const queue = yield* Queue.bounded<Chunk>(64)
	const fibers = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(fibers)()
	yield* Effect.acquireRelease(
		Effect.sync(() => {
			socket.setEncoding("utf8")
			socket.on("data", (data) => {
				socket.pause()
				run(
					Queue.offer(queue, {
						_tag: "Data",
						value: globalThis.String(data),
					}).pipe(
						Effect.andThen(
							Effect.sync(() => {
								socket.resume()
							}),
						),
					),
				)
			})
			socket.on("error", (error) =>
				run(
					Queue.offer(queue, {
						_tag: "Closed",
						reason: "SocketError",
						cause: Cause.die(error),
					}),
				),
			)
			socket.on("close", () =>
				run(
					Queue.offer(queue, {
						_tag: "Closed",
						reason: "Closed",
						cause: Cause.fail("Runner control disconnected"),
					}),
				),
			)
		}),
		() =>
			Effect.sync(() => {
				socket.destroy()
			}),
	)
	return Stream.unfold("", (remainder) =>
		pull(queue, remainder).pipe(
			Effect.map(
				([lines, rest]) =>
					[lines, rest] satisfies readonly [ReadonlyArray<string>, string],
			),
		),
	).pipe(Stream.flattenIterable)
})
export const write = (socket: Socket, line: string): Effect.Effect<void> =>
	Effect.callback((resume) => {
		socket.write(line + "\n", (error) =>
			resume(
				error !== null && error !== undefined ? Effect.die(error) : Effect.void,
			),
		)
	})
