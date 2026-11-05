import { Array, Effect, Layer, Ref, Stream, String } from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { heartbeat, makeClient } from "../src/main.ts"

const text = (entry: Graft.LogEntry) =>
	Array.join(
		Array.map(Array.ensure(entry.message), (part) => `${part}`),
		" ",
	)

/** Every log message written so far, oldest first. */
const messages = Effect.gen(function* () {
	yield* Effect.log("end of log")
	const entries = yield* Stream.runCollect(
		Stream.takeUntil(Graft.logs, (entry) => text(entry) === "end of log"),
	)
	return Array.dropRight(Array.map(entries, text), 1)
})

describe("failures", () => {
	it.effect("retries the client while the heartbeat keeps running", () =>
		Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const beat = yield* Graft.plugin(heartbeat)
					const attempts = yield* Ref.make(0)
					yield* Graft.plugin(makeClient(attempts))
					// Advance the test clock step by step, so each retry gets to run.
					yield* Effect.repeat(TestClock.adjust("100 millis"), { times: 9 })
					const connections = yield* Ref.get(attempts)
					assert.strictEqual(connections, 3)
					yield* beat.await
				}),
			)
			const log = yield* messages
			assert.deepStrictEqual(
				Array.filter(log, (line) => !String.startsWith("heartbeat")(line)),
				[
					"Connecting, attempt 1",
					'Plugin "client" failed',
					"Connecting, attempt 2",
					'Plugin "client" failed',
					"Connecting, attempt 3",
					"Connected",
				],
			)
			const beats = Array.filter(log, String.startsWith("heartbeat"))
			assert.isAtLeast(beats.length, 3)
		}).pipe(Effect.provide(Layer.fresh(Graft.layer))),
	)
})
