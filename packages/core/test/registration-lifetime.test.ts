import {
	Array,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	References,
	Scope,
	Stream,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { run } from "./utils.ts"

describe("registration lifetime", () => {
	it.effect(
		"releases event keys when the last scoped handler unregisters",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				for (const index of Array.range(1, 20)) {
					const event = Event.make<[]>(`temporary-event-${index}`)
					yield* Effect.scoped(Event.on(event, () => Effect.void))
				}
				const events = yield* TxRef.get(runtime.events)
				assert.strictEqual(HashMap.size(events), 0)
			}).pipe(run),
	)

	// Each cancellation boundary has its own result and timeout, independent of suite load.
	it.effect.each(Array.range(0, 100))(
		"does not leave fork entries after %i scheduler yields",
		(ticks) =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const plugin = Plugin.make({
					name: "registration",
					apply: () => Effect.void,
				})
				const owner = yield* Scope.make()
				const registering = yield* Graft.plugin(plugin).pipe(
					Scope.provide(owner),
					Effect.provideService(References.MaxOpsBeforeYield, 4),
					Effect.forkScoped,
				)
				for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow
				yield* Fiber.interrupt(registering)
				yield* Scope.close(owner, Exit.void)
				const entries = yield* TxSubscriptionRef.get(runtime.forks)
				assert.strictEqual(
					HashMap.size(entries),
					0,
					`Fork entry leaked after ${ticks} yields`,
				)
			}).pipe(run),
	)

	it.effect(
		"does not leave event handlers behind at registration interruption boundaries",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const event = Event.make<[]>("interrupted-registration")
				for (const ticks of Array.range(0, 100)) {
					const owner = yield* Scope.make()
					const registering = yield* Event.on(event, () => Effect.void).pipe(
						Scope.provide(owner),
						Effect.provideService(References.MaxOpsBeforeYield, 4),
						Effect.forkScoped,
					)
					for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow
					yield* Fiber.interrupt(registering)
					yield* Scope.close(owner, Exit.void)
					const events = yield* TxRef.get(runtime.events)
					const handlers = Option.getOrElse(
						HashMap.get(events, event.key),
						() => [],
					)
					assert.strictEqual(
						handlers.length,
						0,
						`Handler leaked after ${ticks} yields`,
					)
				}
			}).pipe(run),
	)

	it.effect.each(Array.range(0, 100))(
		"fully starts a published fork cancelled after %i scheduler yields",
		(ticks) =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const plugin = Plugin.make({
					name: "cancelled load",
					apply: () => Effect.void,
				})
				const owner = yield* Effect.acquireRelease(Scope.make(), (owner) =>
					Scope.close(owner, Exit.void),
				)
				const registering = yield* Graft.plugin(plugin).pipe(
					Scope.provide(owner),
					Effect.provideService(References.MaxOpsBeforeYield, 4),
					Effect.forkScoped,
				)
				for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow
				yield* Fiber.interrupt(registering)
				// A published fork must have a supervisor even when the caller never gets its handle.
				yield* Effect.tx(
					Effect.gen(function* () {
						const entries = yield* TxSubscriptionRef.get(runtime.forks)
						if (
							Array.some(
								HashMap.toValues(entries),
								(entry) => entry.state._tag === "Loading",
							)
						)
							return yield* Effect.txRetry
					}),
				)
				yield* Scope.close(owner, Exit.void)
			}).pipe(run),
	)

	it.effect(
		"returns a disposed fork when loading into an already closed scope",
		() =>
			Effect.gen(function* () {
				const owner = yield* Scope.make()
				yield* Scope.close(owner, Exit.void)
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "closed owner",
						apply: () => Effect.die("A closed owner must not run apply"),
					}),
				).pipe(Scope.provide(owner))
				yield* fork.await
				yield* fork.update(undefined)
				yield* fork.restart
				const states = yield* Stream.runCollect(fork.state)
				assert.deepStrictEqual(
					Array.map(states, (state) => state._tag),
					["Disposed"],
				)
				const tree = yield* Stream.runHead(Graft.forks)
				assert.deepStrictEqual(Option.getOrThrow(tree), [])
			}).pipe(run),
	)
})
