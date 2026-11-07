import { MessagePort } from "node:worker_threads"

import { Effect, FiberSet, Queue, Schema } from "effect"
import type { RpcMessage } from "effect/rpc"

// This module deliberately has no dependency on the contract or its schemas.
export const Declaration = Schema.Struct({
	identity: Schema.String,
	tag: Schema.String,
	build: Schema.String,
})
export type Declaration = typeof Declaration.Type
export const Mode = Schema.Literals([
	"success",
	"error",
	"ensuring",
	"scope",
	"scope-success",
])
export const Command = Schema.Union([
	Schema.TaggedStruct("Bind", {
		generation: Schema.String,
		port: Schema.instanceOf(MessagePort),
	}),
	Schema.TaggedStruct("Call", {
		id: Schema.String,
		mode: Mode,
		generation: Schema.String,
	}),
	Schema.TaggedStruct("Cancel", { id: Schema.String }),
	Schema.TaggedStruct("Release", {}),
	Schema.TaggedStruct("Barrier", {}),
])
export type Command = typeof Command.Type
export const Event = Schema.Struct({
	phase: Schema.String,
	id: Schema.String,
	checked: Schema.optional(Schema.Boolean),
	declaration: Schema.optional(Declaration),
	diagnostic: Schema.optional(Schema.Unknown),
})
export type Event = typeof Event.Type

export const declarationMatches = (
	consumer: Declaration,
	provider: Declaration,
) =>
	consumer.identity === provider.identity &&
	consumer.tag === provider.tag &&
	consumer.build === provider.build

// Like port.ts, validate the transport envelope; the RPC codec owns its holes.
const Id = Schema.Union([Schema.String, Schema.Finite])
const isRequest = Schema.is(
	Schema.Union([
		Schema.TaggedStruct("Request", { id: Id, tag: Schema.String }),
		Schema.TaggedStruct("Interrupt", { requestId: Id }),
		Schema.TaggedStruct("Ack", { requestId: Id }),
		Schema.TaggedStruct("Eof", {}),
		Schema.TaggedStruct("Ping", {}),
	]),
)
const isResponse = Schema.is(
	Schema.Union([
		Schema.TaggedStruct("Exit", { requestId: Id }),
		Schema.TaggedStruct("Chunk", { requestId: Id }),
		Schema.TaggedStruct("Defect", { defect: Schema.Unknown }),
		Schema.TaggedStruct("Pong", {}),
	]),
)
export const Request = Schema.declare<RpcMessage.FromClientEncoded>(
	(value): value is RpcMessage.FromClientEncoded => isRequest(value),
)
export const Response = Schema.declare<RpcMessage.FromServerEncoded>(
	(value): value is RpcMessage.FromServerEncoded => isResponse(value),
)

export const inbox = Effect.fnUntraced(function* (port: MessagePort) {
	const queue = yield* Queue.unbounded<unknown>()
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const listener = (value: unknown) => {
		run(Queue.offer(queue, value))
	}
	yield* Effect.acquireRelease(
		Effect.sync(() => port.on("message", listener)),
		() =>
			Effect.sync(() => {
				port.off("message", listener)
			}),
	)
	return queue
})
