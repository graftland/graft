import { Array, Effect, Exit, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import greeter from "../src/greeter.ts"
import ticker from "../src/ticker.ts"

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

describe("config-file", () => {
	it.effect("greets on start and on every config change", () =>
		Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const fork = yield* Graft.plugin(greeter, { name: "Alice" })
					yield* fork.await
					yield* fork.update({ name: "Bob" })
					yield* fork.await
				}),
			)
			const log = yield* messages
			assert.deepStrictEqual(log, [
				"Hello, Alice!",
				"Goodbye, Alice!",
				"Hello, Bob!",
				"Goodbye, Bob!",
			])
		}).pipe(Effect.provide(Layer.fresh(Graft.layer))),
	)

	it.effect("ticks until it is unloaded", () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(ticker, { seconds: 2 })
			yield* fork.await
			yield* TestClock.adjust("5 seconds")
			yield* fork.dispose
			yield* TestClock.adjust("10 seconds")
			const log = yield* messages
			assert.deepStrictEqual(log, ["tick", "tick", "tick"])
		}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer))),
	)

	it.effect("rejects a period that is not positive", () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(ticker, { seconds: 0 })
			const exit = yield* Effect.exit(fork.await)
			assert.isTrue(Exit.isFailure(exit))
			const state = yield* Stream.runHead(fork.state)
			assert.deepStrictEqual(
				Option.map(state, (state) => state._tag),
				Option.some("Failed"),
			)
			const log = yield* messages
			assert.isFalse(Array.contains(log, "tick"))
		}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer))),
	)
})
