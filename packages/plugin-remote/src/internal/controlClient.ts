import { createConnection, type Socket } from "node:net"

import {
	Cause,
	Deferred,
	Effect,
	FiberSet,
	HashMap,
	Option,
	PubSub,
	Ref,
	Scope,
	Stream,
} from "effect"

import type * as Kernel from "@graftland/graft/Kernel"

import * as Wire from "./controlProtocol"
import * as Limit from "./encodedLimit"
import * as Lines from "./jsonLines"

export interface Handle {
	readonly id: string
	readonly await: Effect.Effect<Kernel.Conclusion, Wire.ControlError>
	readonly cancel: Effect.Effect<void, Wire.ControlError>
}
export interface Client {
	readonly submit: (
		input: Kernel.Request,
	) => Effect.Effect<Handle, Wire.ControlError>
	readonly handle: (id: string) => Handle
	readonly get: (
		id: string,
	) => Effect.Effect<Option.Option<Kernel.Status>, Wire.ControlError>
	readonly observe: (
		id: string,
	) => Stream.Stream<Kernel.Status, Wire.ControlError>
	readonly changes: Stream.Stream<Kernel.Status, Wire.ControlError>
	readonly preparationChanges: Stream.Stream<
		Kernel.PreparationStatus,
		Wire.ControlError
	>
	readonly callChanges: Stream.Stream<Kernel.CallFact, Wire.ControlError>
	readonly inspect: (
		input: Kernel.InspectionInput,
	) => Effect.Effect<Kernel.PreparationStatus, Wire.ControlError>
	readonly getPreparation: (
		id: string,
	) => Effect.Effect<Option.Option<Kernel.PreparationStatus>, Wire.ControlError>
	readonly units: Effect.Effect<ReadonlyArray<Kernel.Unit>, Wire.ControlError>
	readonly preparations: Effect.Effect<
		ReadonlyArray<Kernel.PreparationStatus>,
		Wire.ControlError
	>
	readonly recording: Effect.Effect<
		{
			readonly grant: Option.Option<Kernel.RecorderGrant>
			readonly outstanding: ReadonlyArray<Kernel.RecordDuty>
		},
		Wire.ControlError
	>
	readonly waiters: Effect.Effect<
		ReadonlyArray<Kernel.CallWaiter>,
		Wire.ControlError
	>
	readonly calls: Effect.Effect<
		ReadonlyArray<Kernel.CallFact>,
		Wire.ControlError
	>
	readonly setPolicy: (
		policy: Wire.Policy,
	) => Effect.Effect<void, Wire.ControlError>
	readonly shutdown: Effect.Effect<void, Wire.ControlError>
	readonly close: Effect.Effect<void>
}
interface Runtime {
	readonly socket: Socket
	readonly address: Wire.Address
	readonly next: Ref.Ref<number>
	readonly pending: Ref.Ref<
		HashMap.HashMap<string, Deferred.Deferred<Wire.Response, Wire.ControlError>>
	>
	readonly notifications: PubSub.PubSub<Wire.Outgoing>
	readonly closed: Ref.Ref<boolean>
}
const error = (reason: string, cause: Cause.Cause<unknown>) =>
	Wire.ControlError.make({ reason, cause })
const close = Effect.fnUntraced(function* (
	runtime: Runtime,
	cause: Cause.Cause<unknown>,
) {
	yield* Ref.set(runtime.closed, true)
	const pending = yield* Ref.getAndSet(runtime.pending, HashMap.empty())
	yield* Effect.forEach(
		HashMap.values(pending),
		(d) => Deferred.fail(d, error("Disconnected", cause)),
		{ discard: true },
	)
	yield* Effect.sync(() => runtime.socket.destroy())
})
const receive = Effect.fnUntraced(function* (
	runtime: Runtime,
	frame: Wire.Outgoing,
) {
	if (frame._tag !== "Reply") {
		yield* PubSub.publish(runtime.notifications, frame)
		return
	}
	const pending = yield* Ref.get(runtime.pending)
	const waiter = HashMap.get(pending, frame.id)
	if (Option.isSome(waiter)) yield* Deferred.succeed(waiter.value, frame.result)
})
const request = Effect.fnUntraced(function* (
	runtime: Runtime,
	value: Wire.Request,
): Effect.fn.Return<Wire.Response, Wire.ControlError> {
	return yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			if (yield* Ref.get(runtime.closed))
				return yield* error(
					"Disconnected",
					Cause.fail("The control connection is closed"),
				)
			const sequence = yield* Ref.getAndUpdate(runtime.next, (n) => n + 1)
			const id = globalThis.String(sequence)
			const waiter = yield* Deferred.make<Wire.Response, Wire.ControlError>()
			const accepted = yield* Ref.modify(runtime.pending, (p) =>
				HashMap.size(p) >= 64 ? [false, p] : [true, HashMap.set(p, id, waiter)],
			)
			if (!accepted)
				return yield* error(
					"Saturated",
					Cause.fail("The control request limit is full"),
				)
			const frame = { id, token: runtime.address.token, request: value }
			const result = yield* restore(
				Limit.check(frame).pipe(
					Effect.andThen(Wire.encodeRequest(frame)),
					Effect.flatMap((line) => Lines.write(runtime.socket, line)),
					Effect.andThen(Deferred.await(waiter)),
					Effect.catchCause((cause) => error("Transport", cause)),
				),
			).pipe(Effect.ensuring(Ref.update(runtime.pending, HashMap.remove(id))))
			if (result._tag === "Failure")
				return yield* Wire.ControlError.make({
					reason: result.reason,
					cause: result.cause,
					conflicts: result.conflicts,
					...(result.preparation === undefined
						? {}
						: { preparation: result.preparation }),
				})
			return result
		}),
	)
})
const unexpected = (value: Wire.Response) =>
	error("Protocol", Cause.fail(`Unexpected control response: ${value._tag}`))
const action = (r: Runtime, value: Wire.Request) =>
	request(r, value).pipe(
		Effect.flatMap((v) => (v._tag === "Ack" ? Effect.void : unexpected(v))),
	)
const awaitChange = (r: Runtime, id: string) =>
	request(r, { _tag: "Await", id }).pipe(
		Effect.flatMap((v) =>
			v._tag === "Outcome" ? Effect.succeed(v.value) : unexpected(v),
		),
	)
const get = (r: Runtime, id: string) =>
	request(r, { _tag: "Get", id }).pipe(
		Effect.flatMap((v) =>
			v._tag === "Status" ? Effect.succeed(v.value) : unexpected(v),
		),
	)
const handle = (r: Runtime, id: string): Handle => ({
	id,
	await: awaitChange(r, id),
	cancel: action(r, { _tag: "Cancel", id }),
})
const notifications = (r: Runtime) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const queue = yield* PubSub.subscribe(r.notifications)
			yield* action(r, { _tag: "Ping" })
			return Stream.fromSubscription(queue)
		}),
	)
const observe = (r: Runtime, id: string) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const queue = yield* PubSub.subscribe(r.notifications)
			const initial = yield* get(r, id)
			return Stream.concat(
				Stream.fromIterable(Option.toArray(initial)),
				Stream.fromSubscription(queue).pipe(
					Stream.filter((frame) => frame._tag === "Change"),
					Stream.filter((frame) => frame.value.id === id),
					Stream.map((frame) => frame.value),
				),
			)
		}),
	)
const client = (r: Runtime): Client => ({
	submit: (input) =>
		request(r, { _tag: "Submit", input }).pipe(
			Effect.flatMap((v) =>
				v._tag === "Submitted"
					? Effect.succeed(handle(r, v.id))
					: unexpected(v),
			),
		),
	handle: (id) => handle(r, id),
	get: (id) => get(r, id),
	observe: (id) => observe(r, id),
	changes: notifications(r).pipe(
		Stream.filter((v) => v._tag === "Change"),
		Stream.map((v) => v.value),
	),
	preparationChanges: notifications(r).pipe(
		Stream.filter((v) => v._tag === "Preparation"),
		Stream.map((v) => v.value),
	),
	callChanges: notifications(r).pipe(
		Stream.filter((v) => v._tag === "Call"),
		Stream.map((v) => v.value),
	),
	inspect: (input) =>
		request(r, { _tag: "Inspect", input }).pipe(
			Effect.flatMap((v) =>
				v._tag === "Preparation" && Option.isSome(v.value)
					? Effect.succeed(v.value.value)
					: unexpected(v),
			),
		),
	getPreparation: (id) =>
		request(r, { _tag: "GetPreparation", id }).pipe(
			Effect.flatMap((v) =>
				v._tag === "Preparation" ? Effect.succeed(v.value) : unexpected(v),
			),
		),
	units: request(r, { _tag: "Units" }).pipe(
		Effect.flatMap((v) =>
			v._tag === "Units" ? Effect.succeed(v.value) : unexpected(v),
		),
	),
	preparations: request(r, { _tag: "Preparations" }).pipe(
		Effect.flatMap((v) =>
			v._tag === "Preparations" ? Effect.succeed(v.value) : unexpected(v),
		),
	),
	recording: request(r, { _tag: "Recording" }).pipe(
		Effect.flatMap((v) =>
			v._tag === "Recording"
				? Effect.succeed({ grant: v.grant, outstanding: v.outstanding })
				: unexpected(v),
		),
	),
	waiters: request(r, { _tag: "Waiters" }).pipe(
		Effect.flatMap((v) =>
			v._tag === "Waiters" ? Effect.succeed(v.value) : unexpected(v),
		),
	),
	calls: request(r, { _tag: "Calls" }).pipe(
		Effect.flatMap((v) =>
			v._tag === "Calls" ? Effect.succeed(v.value) : unexpected(v),
		),
	),
	setPolicy: (policy) => action(r, { _tag: "SetPolicy", policy }),
	shutdown: action(r, { _tag: "Shutdown" }),
	close: close(r, Cause.fail("The caller closed control")),
})
/** Connects through fixed metadata codecs; interruption of await never sends Change cancellation. */
export const connect = Effect.fnUntraced(function* (
	address: Wire.Address,
): Effect.fn.Return<Client, Wire.ControlError, Scope.Scope> {
	const ready = yield* Deferred.make<void, Wire.ControlError>()
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const socket = yield* Effect.sync(() =>
		createConnection({ host: address.host, port: address.port }),
	)
	socket.once("connect", () => run(Deferred.succeed(ready, undefined)))
	socket.once("error", (cause) =>
		run(Deferred.fail(ready, error("Connect", Cause.die(cause)))),
	)
	const runtime: Runtime = {
		socket,
		address,
		next: yield* Ref.make(1),
		pending: yield* Ref.make(
			HashMap.empty<
				string,
				Deferred.Deferred<Wire.Response, Wire.ControlError>
			>(),
		),
		notifications: yield* PubSub.sliding<Wire.Outgoing>(64),
		closed: yield* Ref.make(false),
	}
	yield* Effect.addFinalizer(() =>
		close(runtime, Cause.fail("The control client Scope ended")),
	)
	const incoming = yield* Lines.receive(socket)
	yield* Stream.runForEach(incoming, (line) =>
		Wire.decodeResponse(line).pipe(
			Effect.flatMap((frame) => receive(runtime, frame)),
		),
	).pipe(
		Effect.catchCause((cause) => close(runtime, cause)),
		Effect.forkScoped,
	)
	yield* Deferred.await(ready)
	return client(runtime)
})
