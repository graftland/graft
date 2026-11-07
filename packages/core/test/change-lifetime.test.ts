import {
	Array,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	Scope,
	Stream,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { budget, candidate, register } from "./change-driver.ts"
import { run } from "./utils.ts"

it.effect("fully disposed registrations close their runtime-owned scopes", () =>
	run(
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const scopes = yield* Effect.forEach(Array.range(1, 3), () =>
				Effect.gen(function* () {
					const registered = yield* register("a")
					const instances = yield* TxRef.get(runtime.instances)
					const managed = HashMap.getUnsafe(instances, "a")
					yield* registered.fork.dispose
					return managed.scope
				}),
			)
			assert.deepStrictEqual(
				Array.map(scopes, (scope) => scope.state._tag),
				["Closed", "Closed", "Closed"],
			)
		}),
	),
)

it.effect(
	"keeps a disposed registration scope until Stuck obligations settle after late exit",
	() =>
		run(
			Effect.gen(function* () {
				const h = yield* register("a", { holdOldExit: true })
				const { runtime } = yield* RuntimeContext
				const instances = yield* TxRef.get(runtime.instances)
				const managed = HashMap.getUnsafe(instances, "a")
				const closed = yield* Deferred.make<void>()
				yield* Scope.addFinalizer(
					managed.scope,
					Deferred.succeed(closed, undefined),
				)
				const terminating = yield* Change.changes.pipe(
					Stream.filter(
						(status) =>
							status.instance === "a" && status.phase === "Terminating",
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					budget,
				})
				yield* Fiber.join(terminating)
				yield* TestClock.adjust(100)
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Stuck")
				const disposal = yield* h.fork.dispose.pipe(
					Effect.exit,
					Effect.forkScoped,
				)
				yield* TestClock.adjust(budget.total)
				yield* Fiber.join(disposal)
				assert.strictEqual(managed.scope.state._tag, "Open")
				const pending = yield* TxRef.get(managed.pending)
				assert.isTrue(HashSet.has(pending, handle.id))
				yield* Deferred.succeed(h.oldExit, { unit: "a-1", state: "Exited" })
				yield* Deferred.await(closed)
				assert.strictEqual(managed.scope.state._tag, "Closed")
				const settled = yield* TxRef.get(managed.pending)
				assert.strictEqual(HashSet.size(settled), 0)
			}),
		),
)

it.effect(
	"releases the unadmitted registration scope when its instance name is already registered",
	() =>
		run(
			Effect.gen(function* () {
				yield* register("a")
				const { runtime } = yield* RuntimeContext
				const retained = () => {
					const state = runtime.changes.scope.state
					return state._tag !== "Open"
						? 0
						: (state.finalizer === undefined ? 0 : 1) +
								(state.finalizers?.size ?? 0)
				}
				const before = retained()
				yield* Effect.forEach(Array.range(1, 3), () =>
					Effect.result(register("a")),
				)
				assert.strictEqual(retained(), before)
			}),
		),
)
