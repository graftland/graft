import { Array, Deferred, Effect, Fiber, Queue, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import * as Notifications from "../src/Notifications"

it.live(
	"delivers in order and acknowledges a notification only after its handler finished",
	() =>
		Effect.gen(function* () {
			const { publish, channel } = yield* Notifications.emitter<number>({
				wait: "20 millis",
			})
			const seen = yield* Ref.make<ReadonlyArray<number>>([])
			const gate = yield* Deferred.make<void>()
			const handled = yield* Queue.unbounded<number>()
			const subscriber = yield* Notifications.subscribe(channel, (delivery) =>
				delivery._tag === "Delivered"
					? Effect.gen(function* () {
							if (delivery.payload === 1) yield* Deferred.await(gate)
							yield* Ref.update(seen, Array.append(delivery.payload))
							yield* Queue.offer(handled, delivery.payload)
						})
					: Effect.die("unexpected delivery"),
			).pipe(Effect.forkScoped)
			yield* Effect.sleep("30 millis")
			yield* publish(1)
			yield* publish(2)
			yield* publish(3)
			yield* Effect.sleep("30 millis")
			const beforeRelease = yield* Ref.get(seen)
			assert.deepStrictEqual(beforeRelease, [])
			yield* Deferred.succeed(gate, undefined)
			yield* Queue.take(handled)
			yield* Queue.take(handled)
			yield* Queue.take(handled)
			const order = yield* Ref.get(seen)
			assert.deepStrictEqual(order, [1, 2, 3])
			yield* Fiber.interrupt(subscriber)
		}).pipe(Effect.scoped),
)

it.live(
	"reports a delivery whose result is unknown as Lost and never sends it again",
	() =>
		Effect.gen(function* () {
			const { publish, channel } = yield* Notifications.emitter<string>({
				wait: "10 millis",
			})
			const session = yield* channel.subscribe
			yield* publish("first")
			yield* publish("second")
			const first = yield* channel.next(session, 0)
			assert.deepStrictEqual(first, {
				_tag: "Delivered",
				seq: 1,
				payload: "first",
			})
			// The reply carrying seq 1 never arrived: the subscriber pulls again from 0.
			const lost = yield* channel.next(session, 0)
			assert.deepStrictEqual(lost, { _tag: "Lost", seq: 1 })
			const second = yield* channel.next(session, 1)
			assert.deepStrictEqual(second, {
				_tag: "Delivered",
				seq: 2,
				payload: "second",
			})
			const idle = yield* channel.next(session, 2)
			assert.deepStrictEqual(idle, { _tag: "Idle" })
		}),
)

it.live(
	"bounds each session's queue and reports dropped notifications explicitly",
	() =>
		Effect.gen(function* () {
			const { publish, channel } = yield* Notifications.emitter<number>({
				capacity: 2,
				wait: "10 millis",
			})
			const session = yield* channel.subscribe
			yield* Effect.forEach(Array.range(1, 5), publish, { discard: true })
			const dropped = yield* channel.next(session, 0)
			assert.deepStrictEqual(dropped, { _tag: "Dropped", count: 3 })
			const fourth = yield* channel.next(session, 0)
			assert.deepStrictEqual(fourth, { _tag: "Delivered", seq: 4, payload: 4 })
			const fifth = yield* channel.next(session, 4)
			assert.deepStrictEqual(fifth, { _tag: "Delivered", seq: 5, payload: 5 })
		}),
)

it.live(
	"starts a session with the next notification and keeps sessions independent",
	() =>
		Effect.gen(function* () {
			const { publish, channel } = yield* Notifications.emitter<string>({
				wait: "10 millis",
			})
			yield* publish("before")
			const a = yield* channel.subscribe
			yield* publish("shared")
			const b = yield* channel.subscribe
			const forA = yield* channel.next(a, 0)
			const forB = yield* channel.next(b, 0)
			assert.deepStrictEqual(forA, {
				_tag: "Delivered",
				seq: 2,
				payload: "shared",
			})
			assert.deepStrictEqual(forB, { _tag: "Idle" })
		}),
)
