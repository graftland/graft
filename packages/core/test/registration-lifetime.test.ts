import {
	Array,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Option,
	References,
	Scope,
	Stream,
	TxSubscriptionRef,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { run } from "./b1b-utils.ts"

describe("registration lifetime", () => {
	// Each cancellation boundary has its own result and timeout, independent of suite load.
	it.effect.each(Array.range(0, 100))(
		"does not leave mount entries after %i scheduler yields",
		(ticks) =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const owner = yield* Scope.make()
				const registering = yield* Graft.mount(
					Layer.effectDiscard(Effect.void),
					{ name: "registration" },
				).pipe(
					Scope.provide(owner),
					Effect.provideService(References.MaxOpsBeforeYield, 4),
					Effect.forkScoped,
				)
				for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow
				yield* Fiber.interrupt(registering)
				yield* Scope.close(owner, Exit.void)
				yield* Effect.tx(
					Effect.gen(function* () {
						const entries = yield* TxSubscriptionRef.get(runtime.mounts)
						if (HashMap.size(entries) !== 0) return yield* Effect.txRetry
					}),
				)
			}).pipe(run),
	)

	it.effect.each(Array.range(0, 100))(
		"fully starts a published mount cancelled after %i scheduler yields",
		(ticks) =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const owner = yield* Effect.acquireRelease(Scope.make(), (owner) =>
					Scope.close(owner, Exit.void),
				)
				const registering = yield* Graft.mount(
					Layer.effectDiscard(Effect.void),
					{ name: "cancelled load" },
				).pipe(
					Scope.provide(owner),
					Effect.provideService(References.MaxOpsBeforeYield, 4),
					Effect.forkScoped,
				)
				for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow
				yield* Fiber.interrupt(registering)
				// A published mount must have a supervisor even when the caller never gets its handle.
				yield* Effect.tx(
					Effect.gen(function* () {
						const entries = yield* TxSubscriptionRef.get(runtime.mounts)
						if (
							Array.some(
								HashMap.toValues(entries),
								(entry) => entry.state._tag === "Loading",
							)
						)
							return yield* Effect.txRetry
					}),
				)
			}).pipe(run),
	)

	it.effect(
		"returns an unmounted mount when loading into an already closed scope",
		() =>
			Effect.gen(function* () {
				const owner = yield* Scope.make()
				yield* Scope.close(owner, Exit.void)
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.die("A closed owner must not run the layer"),
					),
					{ name: "closed owner" },
				).pipe(Scope.provide(owner))
				yield* mount.await
				yield* mount.restart
				const states = yield* Stream.runCollect(mount.state)
				assert.deepStrictEqual(
					Array.map(states, (state) => state._tag),
					["Unmounted"],
				)
				const tree = yield* Stream.runHead(Graft.mounts)
				assert.deepStrictEqual(Option.getOrThrow(tree), [])
			}).pipe(run),
	)
})
