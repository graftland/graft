import { Socket } from "node:net"

import {
	Cause,
	Deferred,
	Effect,
	Exit,
	FiberSet,
	HashMap,
	Option,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"

import type { Command, Report, UnitEvent } from "@graftland/graft/Kernel"

import * as EncodedLimit from "./encodedLimit"
import * as Lines from "./jsonLines"
import * as Frames from "./runnerFrames"
import * as Wire from "./unitProtocol"

interface Connection {
	readonly send: (command: Command) => Effect.Effect<Report>
}
const unavailable = (cause: Cause.Cause<unknown>): Report => ({
	_tag: "Failed",
	cause,
	creation: "Unknown",
})
interface Link {
	readonly address: { readonly socket: string; readonly owner: string }
	readonly socket: Socket
	readonly events: (event: UnitEvent) => Effect.Effect<void>
	readonly connected: Deferred.Deferred<void>
	readonly pending: Ref.Ref<HashMap.HashMap<string, Deferred.Deferred<Report>>>
	readonly units: Ref.Ref<HashMap.HashMap<string, Command>>
}
const receiveFrame = Effect.fnUntraced(function* (link: Link, line: string) {
	const frame = yield* Schema.decodeEffect(
		Schema.fromJsonString(Schema.toCodecJson(Frames.Outgoing)),
	)(line)
	if (frame._tag === "Evidence" || frame._tag === "CallEvidence") {
		const event = yield* Frames.decodeEvent(frame)
		yield* link.events(event)
		if (event._tag === "Exited")
			yield* Ref.update(link.units, HashMap.remove(event.incarnation))
		return
	}
	const pending = yield* Ref.get(link.pending)
	const waiter = HashMap.get(pending, frame.command)
	const result: Report =
		frame.result._tag === "Failed"
			? {
					...frame.result,
					cause: yield* Schema.decodeEffect(Wire.Cause)(frame.result.cause),
				}
			: frame.result
	if (Option.isSome(waiter)) yield* Deferred.succeed(waiter.value, result)
	yield* Ref.update(link.pending, HashMap.remove(frame.command))
})
const failLink = Effect.fnUntraced(function* (
	link: Link,
	cause: Cause.Cause<unknown>,
) {
	const owned = yield* Ref.get(link.units)
	const waiters = yield* Ref.get(link.pending)
	yield* Effect.forEach(
		HashMap.values(owned),
		(c) =>
			link.events({
				_tag: "UnitDisconnected",
				unit: c.unit,
				incarnation: c.token.incarnation,
				observer: c.id,
				cause,
			}),
		{ discard: true },
	)
	yield* Effect.forEach(
		HashMap.values(waiters),
		(d) => Deferred.succeed(d, unavailable(cause)),
		{ discard: true },
	)
	yield* Deferred.complete(link.connected, Effect.die(cause))
})
const writeCommand = Effect.fnUntraced(function* (
	link: Link,
	command: Command,
) {
	yield* Deferred.await(link.connected)
	const encoded = yield* Schema.decodeEffect(Wire.Command)(command)
	const line = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.toCodecJson(Frames.Incoming)),
	)({ owner: link.address.owner, command: encoded })
	yield* EncodedLimit.check({ owner: link.address.owner, command: encoded })
	yield* Lines.write(link.socket, line)
})
const request = Effect.fnUntraced(function* (
	link: Link,
	command: Command,
): Effect.fn.Return<Report> {
	const waiter = yield* Deferred.make<Report>()
	yield* Ref.update(link.pending, HashMap.set(command.id, waiter))
	if (command.kind === "Spawn")
		yield* Ref.update(
			link.units,
			HashMap.set(command.token.incarnation, command),
		)
	const sent = yield* Effect.exit(writeCommand(link, command))
	if (Exit.isFailure(sent)) return unavailable(sent.cause)
	return yield* Deferred.await(waiter)
})
const connect = Effect.fnUntraced(function* (
	address: Link["address"],
	events: (event: UnitEvent) => Effect.Effect<void>,
) {
	const socket = yield* Effect.sync(() => new Socket())
	const incoming = yield* Lines.receive(socket)
	const link: Link = {
		address,
		socket,
		events,
		connected: yield* Deferred.make<void>(),
		pending: yield* Ref.make(
			HashMap.empty<string, Deferred.Deferred<Report>>(),
		),
		units: yield* Ref.make(HashMap.empty<string, Command>()),
	}
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	yield* Effect.sync(() => {
		socket.once("connect", () =>
			run(Deferred.succeed(link.connected, undefined)),
		)
		socket.connect(address.socket)
	})
	yield* Stream.runForEach(incoming, (line) => receiveFrame(link, line)).pipe(
		Effect.catchCause((cause) => failLink(link, cause)),
		Effect.forkScoped,
	)
	return {
		send: (command: Command) => request(link, command),
	} satisfies Connection
})
export const make = Effect.fnUntraced(function* (
	events: (event: UnitEvent) => Effect.Effect<void>,
) {
	const connections = yield* Ref.make(HashMap.empty<string, Connection>())
	const scope = yield* Effect.scope
	// Connections are acquired under the placement scope, never a command waiter's scope.
	return Effect.fnUntraced(function* (
		command: Command,
	): Effect.fn.Return<Report> {
		const address = command.target.deployment?.runner
		if (address === undefined)
			return unavailable(Cause.fail("Runner address is required"))
		const key = address.owner + "\u0000" + address.socket
		const known = yield* Ref.get(connections).pipe(
			Effect.map((m) => HashMap.get(m, key)),
		)
		const connection = Option.isSome(known)
			? known.value
			: yield* Scope.provide(connect(address, events), scope)
		yield* Ref.update(connections, HashMap.set(key, connection))
		return yield* connection.send(command)
	})
})
