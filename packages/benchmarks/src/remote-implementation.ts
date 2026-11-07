import process from "node:process"
import { threadId } from "node:worker_threads"

import { Array, Effect, Ref, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Api, Config, contract, Signals } from "./remote-contract"

export default Plugin.make({
	name: "benchmark-remote-implementation",
	config: Config,
	provides: contract.provides,
	inject: [Signals],
	apply: Effect.fnUntraced(function* (initial) {
		const signals = yield* Signals
		const config = yield* Ref.make(initial)
		const calls = yield* Ref.make(0)
		const echo = Effect.fnUntraced(function* (text: string) {
			const sequence = yield* Ref.updateAndGet(calls, (n) => n + 1)
			const value = (yield* Ref.get(config)).value
			return { text, sequence, value }
		})
		yield* Graft.provide(Api, {
			echo,
			batch: (texts) => Effect.forEach(texts, echo),
			info: Effect.gen(function* () {
				const count = yield* Ref.get(calls)
				const value = (yield* Ref.get(config)).value
				const usage = yield* Effect.sync(() => process.memoryUsage())
				return {
					pid: process.pid,
					threadId,
					heap: usage.heapUsed,
					rss: usage.rss,
					calls: count,
					value,
				}
			}),
			values: (count) => Stream.fromIterable(Array.makeBy(count, (n) => n)),
			burn: (iterations) =>
				Effect.andThen(
					signals.notice("cpu"),
					Effect.sync(() => {
						let value = 1
						for (let i = 0; i < iterations; i++)
							value = (Math.imul(value, 1664525) + 1013904223) | 0
						return value
					}),
				),
			logs: (count, paced) =>
				Effect.gen(function* () {
					for (let i = 0; i < count; i++) {
						yield* Effect.logInfo("benchmark remote log")
						if (paced) yield* Effect.sleep("1 millis")
					}
					return count
				}),
			crash: Effect.andThen(
				signals.notice("crash"),
				Effect.sync(() => {
					// The crash is confined to the fixture's explicitly owned process or worker.
					process.exit(73)
				}),
			),
		})
		return (next: typeof Config.Type) =>
			Ref.set(config, next).pipe(Effect.as(true))
	}),
})
