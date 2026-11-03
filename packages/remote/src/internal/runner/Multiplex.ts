import {
	Array,
	Cause,
	Deferred,
	Effect,
	Option,
	Queue,
	Schema,
	Sink,
	Stream,
	TxRef,
} from "effect"
import type { Socket } from "effect/socket"
import { TransportError } from "../../Errors"
import type { Channel as ByteChannel } from "../port"
import * as Framing from "./Framing"

const failure = (detail: string) =>
	TransportError.make({
		cause: Cause.fail(Framing.FrameError.make({ detail })),
	})
const key = (channel: Framing.Channel, priority: Framing.Priority) =>
	channel * 3 + priority

/**
 * One reader/writer for two opaque channels. Each priority has its own fixed
 * credit window, so a stalled instance stream cannot consume control capacity.
 * Payloads are not parsed: forwarding does not require the business RpcGroup.
 */
export const make = Effect.fnUntraced(function* (channel: ByteChannel) {
	const failed = yield* Deferred.make<never, TransportError>()
	const fail = (error: TransportError) =>
		Effect.asVoid(Deferred.fail(failed, error))
	const race = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.raceFirst(effect, Deferred.await(failed))
	const report = (cause: Cause.Cause<unknown>) =>
		fail(TransportError.make({ cause }))
	yield* Effect.addFinalizer(() => fail(failure("Runner channel scope closed")))
	// Wire version 1 accepts all six lanes, even though current RPC traffic uses only two.
	const lanes = yield* Effect.forEach(Array.range(0, 5), () =>
		Effect.gen(function* () {
			return {
				incoming: yield* Queue.dropping<Uint8Array>(Framing.window),
				outgoing: yield* Queue.bounded<{
					readonly frame: Framing.Frame
					readonly bytes: Uint8Array
				}>(Framing.window),
				state: yield* TxRef.make({
					credits: Framing.window,
					sent: 0,
					received: 0,
				}),
			}
		}),
	)
	const credits = yield* Queue.bounded<Framing.Frame>(
		lanes.length * Framing.window,
	)
	const wake = yield* Queue.dropping<void>(1)
	const next = Effect.suspend(
		(): Effect.Effect<
			{ readonly frame: Framing.Frame; readonly bytes: Uint8Array },
			Framing.FrameError
		> =>
			Effect.gen(function* () {
				const credit = yield* Queue.poll(credits)
				if (Option.isSome(credit))
					return {
						frame: credit.value,
						bytes: yield* Framing.encode(credit.value),
					}
				for (const index of [0, 3, 1, 4, 2, 5]) {
					const item = yield* Queue.poll(lanes[index]!.outgoing)
					if (Option.isSome(item)) return item.value
				}
				yield* Queue.take(wake)
				return yield* next
			}),
	)
	const writer = yield* Stream.fromEffectRepeat(next).pipe(
		Stream.mapEffect(({ frame, bytes }) =>
			Effect.gen(function* () {
				yield* TxRef.update(
					lanes[key(frame.channel, frame.priority)]!.state,
					(s) =>
						frame.kind === "Data"
							? { ...s, sent: s.sent + 1 }
							: { ...s, received: s.received - 1 },
				)
				return bytes
			}),
		),
		Stream.run(channel.output),
		race,
		Effect.catchCause(report),
		Effect.forkScoped,
	)
	const decoder = Framing.decoder()
	const reader = yield* channel.input.pipe(
		Stream.runForEach((bytes) =>
			Effect.gen(function* () {
				const frames = decoder.decode(bytes)
				while (true) {
					const item = yield* Effect.try({
						try: () => frames.next(),
						catch: (error) =>
							TransportError.make({
								cause: Schema.is(Framing.FrameError)(error)
									? Cause.fail(error)
									: Cause.die(error),
							}),
					})
					if (item.done === true) return
					const frame = item.value
					const lane = lanes[key(frame.channel, frame.priority)]!
					if (frame.kind === "Data") {
						yield* Effect.tx(
							Effect.gen(function* () {
								const state = yield* TxRef.get(lane.state)
								if (state.received >= Framing.window)
									return yield* failure(
										"Runner peer exceeded its receive window",
									)
								yield* TxRef.set(lane.state, {
									...state,
									received: state.received + 1,
								})
							}),
						)
						if (!(yield* Queue.offer(lane.incoming, frame.payload)))
							return yield* failure("Runner peer exceeded its receive window")
					} else {
						yield* Effect.tx(
							Effect.gen(function* () {
								const state = yield* TxRef.get(lane.state)
								if (state.sent === 0 || state.credits >= Framing.window)
									return yield* failure(
										"Runner peer sent an unsolicited credit",
									)
								yield* TxRef.set(lane.state, {
									...state,
									credits: state.credits + 1,
									sent: state.sent - 1,
								})
							}),
						)
					}
				}
			}),
		),
		Effect.andThen(decoder.finish),
		Effect.andThen(failure("Runner byte channel ended")),
		race,
		Effect.catchCause(report),
		Effect.forkScoped,
	)
	return {
		failed,
		fail,
		reader,
		writer,
		send: (
			channel: Framing.Channel,
			priority: Framing.Priority,
			payload: Uint8Array,
		) =>
			race(
				Effect.gen(function* () {
					const frame: Framing.Frame = {
						channel,
						priority,
						payload,
						kind: "Data",
					}
					const bytes = yield* Framing.encode(frame)
					const lane = lanes[key(channel, priority)]!
					yield* Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							yield* restore(
								Effect.tx(
									Effect.gen(function* () {
										const state = yield* TxRef.get(lane.state)
										if (state.credits === 0) return yield* Effect.txRetry
										yield* TxRef.set(lane.state, {
											...state,
											credits: state.credits - 1,
										})
									}),
								),
							)
							// A reserved credit guarantees an output slot. Commit it before honoring cancellation.
							yield* Queue.offer(lane.outgoing, { frame, bytes })
							yield* Queue.offer(wake, undefined)
						}),
					)
				}),
			),
		take: (channel: Framing.Channel, priority: Framing.Priority) =>
			race(
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const payload = yield* restore(
							Queue.take(lanes[key(channel, priority)]!.incoming),
						)
						// Returning one consumed frame returns exactly one credit, even if the caller is interrupted.
						yield* Queue.offer(credits, {
							channel,
							priority,
							kind: "Credit",
							payload: new Uint8Array(0),
						})
						yield* Queue.offer(wake, undefined)
						return payload
					}),
				),
			),
	}
})

export const fromSocket = Effect.fnUntraced(function* (socket: Socket.Socket) {
	const reader = yield* socket.reader
	const writer = yield* socket.writer
	return yield* make({
		input: Stream.fromEffectRepeat(reader.pull).pipe(
			Stream.flattenIterable,
			Stream.map((bytes) =>
				typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
			),
			Stream.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
		output: Sink.forEach((bytes: Uint8Array) => writer.write(bytes)).pipe(
			Sink.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
	})
})
