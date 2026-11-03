import { assert, describe, it } from "@effect/vitest"
import { type Fork, Graft } from "@graftland/graft"
import { Array, Effect, Layer, Stream } from "effect"
import { english, french, welcome } from "../src/main.ts"

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

const running = (fork: Fork.Fork) =>
	Stream.runHead(Stream.filter(fork.state, (state) => state._tag === "Active"))

const state = (fork: Fork.Fork) =>
	Effect.map(Stream.runHead(fork.state), (state) =>
		state._tag === "Some" ? state.value._tag : "Disposed",
	)

describe("services", () => {
	it.effect("starts the consumer only while a Greeter exists", () =>
		Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const welcomeFork = yield* Graft.plugin(welcome)
					yield* welcomeFork.await
					const waiting = yield* state(welcomeFork)
					assert.strictEqual(waiting, "Pending")

					const englishFork = yield* Graft.plugin(english)
					yield* running(welcomeFork)
					yield* englishFork.dispose
					const waitingAgain = yield* state(welcomeFork)
					assert.strictEqual(waitingAgain, "Pending")

					yield* Graft.plugin(french)
					yield* running(welcomeFork)
				}),
			)
			const log = yield* messages
			assert.deepStrictEqual(log, [
				"Hello, world!",
				"welcome stopped",
				"Bonjour, world !",
				"welcome stopped",
			])
		}).pipe(Effect.provide(Layer.fresh(Graft.layer))),
	)
})
