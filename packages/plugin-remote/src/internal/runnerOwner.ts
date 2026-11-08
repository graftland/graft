import { createServer, type Socket } from "node:net"

import {
	Array,
	Cause,
	Context,
	Effect,
	FiberSet,
	HashMap,
	Layer,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"

import { UnitControl } from "@graftland/graft/Kernel"

import * as Lines from "./jsonLines"
import * as Native from "./nativeControl"
import * as Frames from "./runnerFrames"

const reportClientEnd = (cause: Cause.Cause<unknown>) =>
	cause.reasons.length > 0 &&
	Array.every(
		cause.reasons,
		(reason) =>
			reason._tag === "Fail" &&
			Schema.is(Lines.ConnectionEnded)(reason.error) &&
			reason.error.reason === "Closed",
	)
		? Effect.logDebug("Runner control client disconnected", cause)
		: Effect.logError(cause)

export interface RunnerAddress {
	readonly socket: string
	readonly owner: string
}
export interface RunnerOwner {
	readonly address: RunnerAddress
	/** Disconnects control clients while the execution owner remains alive. */
	readonly disconnect: Effect.Effect<void>
}
const send = Effect.fnUntraced(function* (
	socket: Socket,
	frame: Frames.Outgoing,
) {
	const line = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.toCodecJson(Frames.Outgoing)),
	)(frame)
	yield* Lines.write(socket, line)
})
export const serveRunner = Effect.fnUntraced(function* (
	address: RunnerAddress,
): Effect.fn.Return<RunnerOwner, never, Scope.Scope> {
	const services = yield* Layer.build(Native.localLayer)
	const control = Context.get(services, UnitControl)
	const clients = yield* Ref.make(HashMap.empty<number, Socket>())
	const next = yield* Ref.make(0)
	const fibers = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(fibers)()
	const server = yield* Effect.sync(() =>
		createServer((socket) =>
			run(
				Effect.gen(function* () {
					const id = yield* Ref.getAndUpdate(next, (n) => n + 1)
					yield* Ref.update(clients, HashMap.set(id, socket))
					const incoming = yield* Lines.receive(socket)
					yield* Stream.runForEach(incoming, (line) =>
						Effect.gen(function* () {
							const request = yield* Schema.decodeEffect(
								Schema.fromJsonString(Schema.toCodecJson(Frames.Incoming)),
							)(line)
							if (request.owner !== address.owner)
								return yield* Effect.die("Runner owner identity mismatch")
							const command = Frames.command(request.command)
							yield* Effect.gen(function* () {
								const result = yield* control.send(command)
								yield* send(socket, {
									_tag: "Reply",
									command: command.id,
									result: yield* Frames.encodeReport(result),
								})
							}).pipe(Effect.catchCause(reportClientEnd), Effect.forkScoped)
						}),
					).pipe(Effect.ensuring(Ref.update(clients, HashMap.remove(id))))
				}).pipe(Effect.scoped, Effect.catchCause(reportClientEnd)),
			),
		),
	)
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			server.close()
		}),
	)
	yield* Stream.runForEach(control.events, (event) =>
		Effect.gen(function* () {
			const frame = yield* Frames.encodeEvent(event)
			const connected = yield* Ref.get(clients)
			yield* Effect.forEach(
				HashMap.values(connected),
				(socket) =>
					send(socket, frame).pipe(
						Effect.catchCause((cause) => Effect.logError(cause)),
					),
				{ discard: true },
			)
		}),
	).pipe(Effect.forkScoped)
	yield* Effect.callback<void>((resume) => {
		server.once("error", (error) => resume(Effect.die(error)))
		server.listen(address.socket, () => resume(Effect.void))
	})
	return {
		address,
		disconnect: Effect.gen(function* () {
			const connected = yield* Ref.get(clients)
			yield* Effect.forEach(
				HashMap.values(connected),
				(socket) =>
					Effect.sync(() => {
						socket.destroy()
					}),
				{ discard: true },
			)
		}),
	}
})
