import { assert, describe, it } from "@effect/vitest"
import { Event, Graft } from "@graftland/graft"
import { Array, Effect, Layer, Stream } from "effect"
import { Message, printer, shouter } from "../src/main.ts"

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

describe("events", () => {
	it.effect("removes a plugin's handlers when it unloads", () =>
		Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const printerFork = yield* Graft.plugin(printer)
					const shouterFork = yield* Graft.plugin(shouter)
					yield* printerFork.await
					yield* shouterFork.await
					yield* Event.emit(Message, "hello")
					yield* shouterFork.dispose
					yield* Event.emit(Message, "anyone there?")
				}),
			)
			const log = yield* messages
			assert.deepStrictEqual(log, [
				"printer: hello",
				"shouter: HELLO!",
				"printer: anyone there?",
			])
		}).pipe(Effect.provide(Layer.fresh(Graft.layer))),
	)
})
