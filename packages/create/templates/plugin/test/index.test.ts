import { Array, Effect, Layer, Stream } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import greeter from "../src/index.ts"

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

describe("greeter", () => {
	it.effect("greets on start and on each new config", () =>
		Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const fork = yield* Graft.plugin(greeter, { name: "Alice" })
					yield* fork.await
					yield* fork.update({ name: "Bob" })
					yield* fork.await
					yield* fork.dispose
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
})
