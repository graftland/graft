/**
 * Runs a sample program with the graph and a logger that records its output,
 * so tests can assert what the sample prints.
 */
import { Effect, Layer, Logger, Queue, type Scope } from "effect"

import { Graft } from "@graftland/graft"

const format = (message: unknown): string => {
	if (typeof message === "string") return message
	if (Array.isArray(message)) return message.map(format).join(" ")
	try {
		return JSON.stringify(message) ?? String(message)
	} catch {
		return String(message)
	}
}

export const runWithLogs = <A, E>(
	program: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
): Effect.Effect<readonly [A, ReadonlyArray<string>], E> =>
	Effect.gen(function* () {
		const messages = yield* Queue.unbounded<string>()
		const logger = Logger.layer([
			Logger.make(({ message }) => {
				Queue.offerUnsafe(messages, format(message))
			}),
		])
		const value = yield* Effect.scoped(program).pipe(
			Effect.provide(Layer.provideMerge(Graft.layer, logger)),
		)
		const collected = yield* Queue.takeAll(messages)
		return [value, [...collected]] as const
	})

/**
 * The remote samples build their own graphs, so they need only logging; giving
 * them the outer graph would add a second root that never settles.
 */
export const runScopedWithLogs = <A, E>(
	program: Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<readonly [A, ReadonlyArray<string>], E> =>
	Effect.gen(function* () {
		const messages = yield* Queue.unbounded<string>()
		const logger = Logger.layer([
			Logger.make(({ message }) => {
				Queue.offerUnsafe(messages, format(message))
			}),
		])
		const value = yield* Effect.scoped(program).pipe(Effect.provide(logger))
		const collected = yield* Queue.takeAll(messages)
		return [value, [...collected]] as const
	})
