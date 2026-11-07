import {
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	Ref,
	TxRef,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Fork, Graft, Plugin } from "../src/index.ts"
import { setState } from "../src/internal/forkState.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import * as Snapshots from "../src/internal/snapshot.ts"
import { run } from "./utils.ts"

it.effect(
	"await retains a queued failure followed immediately by Loading",
	() =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "queued transition",
					apply: () =>
						Effect.andThen(Effect.never, Effect.fail("startup failure")),
				}),
			)
			const { runtime } = yield* RuntimeContext
			const entries = yield* Snapshots.get(runtime.forks)
			const entry = Option.getOrThrow(HashMap.get(entries, fork.id))
			const spec = yield* TxRef.get(entry.spec)
			// Start the waiter through subscription and into its blocking queue read.
			const waiting = yield* Effect.forkScoped(Effect.exit(fork.await), {
				startImmediately: true,
			})
			const cause = Cause.combine(
				Cause.fail("startup failure"),
				Cause.die("cleanup defect"),
			)
			yield* Effect.tx(
				setState(
					runtime,
					fork.id,
					entry.status,
					Fork.ForkState.Failed({ cause }),
					spec,
				).pipe(
					Effect.andThen(
						setState(
							runtime,
							fork.id,
							entry.status,
							Fork.ForkState.Loading(),
							spec,
						),
					),
				),
			)
			const result = yield* Fiber.join(waiting)
			assert.deepStrictEqual(result, Exit.failCause(cause))
			yield* fork.dispose
		}).pipe(run),
)

it.effect(
	"reuses await after failure and disposal without replaying a stale cause",
	() =>
		Effect.gen(function* () {
			const cause = Cause.combine(
				Cause.fail("startup failure"),
				Cause.die("startup defect"),
			)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "settled snapshot",
					apply: () => Effect.failCause(cause),
				}),
			)
			const first = yield* Effect.exit(fork.await)
			const second = yield* Effect.exit(fork.await)
			assert.isTrue(Exit.isFailure(first))
			if (Exit.isFailure(first)) {
				assert.include(Cause.pretty(first.cause), "startup failure")
				assert.include(Cause.pretty(first.cause), "startup defect")
			}
			assert.deepStrictEqual(second, first)
			yield* fork.dispose
			yield* fork.await
			yield* fork.await
		}).pipe(run),
)

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/load-dispose-transitions.test/Service",
) {}

it.effect(
	"closes publication before finalizers when no consumer holds a lease",
	() =>
		Effect.gen(function* () {
			const observed = yield* Ref.make(
				Option.none<Exit.Exit<void, Graft.ServiceConflict>>(),
			)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "unleased provider",
					apply: () =>
						Graft.provide(Service, "initial").pipe(
							Effect.andThen(
								Effect.addFinalizer(() =>
									Effect.flatMap(
										Effect.exit(Graft.provide(Service, "late")),
										(exit) => Ref.set(observed, Option.some(exit)),
									),
								),
							),
						),
				}),
			)
			yield* fork.await
			yield* fork.dispose
			const result = yield* Ref.get(observed)
			const exit = Option.getOrThrow(result)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit)) assert.isTrue(Cause.hasDies(exit.cause))
			const { runtime } = yield* RuntimeContext
			const slots = yield* TxRef.get(runtime.slots)
			assert.strictEqual(HashMap.size(slots), 0)
		}).pipe(run),
)
