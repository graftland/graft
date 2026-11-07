import {
	Array,
	Cause,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	Option,
	Stream,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { budget, candidate, register } from "./change-driver.ts"
import { run } from "./utils.ts"

it.effect(
	"handles a completed preparation cleanup defect as failure rather than unresolved settlement",
	() =>
		run(
			Effect.gen(function* () {
				yield* register("terminal-cleanup", {
					prepare: (desired) =>
						Effect.gen(function* () {
							if (desired.identity === "next")
								yield* Effect.addFinalizer(() =>
									Effect.die("Preparation cleanup failed completely"),
								)
							return { overlap: true }
						}),
				})
				const handle = yield* Change.submit({
					instance: "terminal-cleanup",
					candidate: candidate("next"),
					budget,
				})
				const outcome = yield* handle.await
				const observed = yield* Change.get(handle.id)
				const status = Option.getOrThrow(observed)
				assert.strictEqual(status.preparation?.cleanup, "Failed")
				assert.include(
					Cause.pretty(status.preparation?.cause ?? Cause.empty),
					"Preparation cleanup failed completely",
				)
				assert.strictEqual(
					outcome._tag,
					"Recovered",
					"Cleanup has a completed defect Exit; there is no unresolved execution or attribution",
				)
			}),
		),
)

it.effect(
	"retains recovery reservations until the previous generation has exit evidence",
	() =>
		run(
			Effect.gen(function* () {
				const fixture = yield* register("terminal-old-exit", {
					holdOldExit: true,
				})
				const trial = yield* Change.changes.pipe(
					Stream.filter(
						(status) =>
							status.instance === "terminal-old-exit" &&
							status.phase === "Trial",
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				const oldTerminating = yield* Change.changes.pipe(
					Stream.filter(
						(status) =>
							status.instance === "terminal-old-exit" &&
							status.phase === "Terminating" &&
							Array.some(
								status.evidence,
								(item) => item.attempt === 1 && item.phase === "Stopping",
							),
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				const handle = yield* Change.submit({
					instance: "terminal-old-exit",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
					requirements: { trial: 10 },
				})
				yield* Fiber.join(trial)
				yield* handle.cancel
				yield* Fiber.join(oldTerminating)
				yield* TestClock.adjust(100)
				const outcome = yield* handle.await
				const { runtime } = yield* RuntimeContext
				const retained = yield* TxRef.get(runtime.changes.settled)
				assert.isFalse(Array.contains(retained, handle.id))
				const next = yield* Change.submit({
					instance: "terminal-old-exit",
					candidate: candidate("third"),
					budget,
				}).pipe(Effect.result)
				yield* Deferred.succeed(fixture.oldExit, {
					unit: "old-exit-1",
					state: "Exited",
				})
				if (next._tag === "Success") yield* next.success.await
				const instances = yield* TxRef.get(runtime.instances)
				const managed = HashMap.getUnsafe(
					instances,
					outcome.members[0]!.instance,
				)
				yield* Effect.tx(
					TxRef.get(managed.pending).pipe(
						Effect.flatMap((pending) =>
							HashSet.size(pending) === 0 ? Effect.void : Effect.txRetry,
						),
					),
				)
				const repeated = yield* handle.await
				assert.strictEqual(repeated, outcome)
				const archived = yield* TxRef.get(runtime.changes.settled)
				assert.isTrue(Array.contains(archived, handle.id))
				assert.strictEqual(
					outcome._tag,
					"Stuck",
					`Outcome ${outcome._tag}; subsequent admission ${next._tag}`,
				)
				assert.strictEqual(next._tag, "Failure")
				if (next._tag === "Failure")
					assert.strictEqual(next.failure.reason._tag, "Busy")
			}),
		),
)

it.effect(
	"retains recovery reservations until previous host cleanup completes",
	() =>
		run(
			Effect.gen(function* () {
				const cleanupEntered = yield* Deferred.make<void>()
				const cleanupRelease = yield* Deferred.make<void>()
				yield* register("terminal-old-cleanup", {
					cleanup: Deferred.succeed(cleanupEntered, undefined).pipe(
						Effect.andThen(Deferred.await(cleanupRelease)),
					),
				})
				const trial = yield* Change.changes.pipe(
					Stream.filter(
						(status) =>
							status.instance === "terminal-old-cleanup" &&
							status.phase === "Trial",
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				const handle = yield* Change.submit({
					instance: "terminal-old-cleanup",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
					requirements: { trial: 10 },
				})
				yield* Fiber.join(trial)
				yield* handle.cancel
				yield* Deferred.await(cleanupEntered)
				yield* TestClock.adjust(100)
				const outcome = yield* handle.await
				const { runtime } = yield* RuntimeContext
				const retained = yield* TxRef.get(runtime.changes.settled)
				assert.isFalse(Array.contains(retained, handle.id))
				const next = yield* Change.submit({
					instance: "terminal-old-cleanup",
					candidate: candidate("third"),
					budget,
				}).pipe(Effect.result)
				yield* Deferred.succeed(cleanupRelease, undefined)
				if (next._tag === "Success") yield* next.success.await
				const instances = yield* TxRef.get(runtime.instances)
				const managed = HashMap.getUnsafe(
					instances,
					outcome.members[0]!.instance,
				)
				yield* Effect.tx(
					TxRef.get(managed.pending).pipe(
						Effect.flatMap((pending) =>
							HashSet.size(pending) === 0 ? Effect.void : Effect.txRetry,
						),
					),
				)
				const repeated = yield* handle.await
				assert.strictEqual(repeated, outcome)
				const archived = yield* TxRef.get(runtime.changes.settled)
				assert.isTrue(Array.contains(archived, handle.id))
				assert.strictEqual(
					outcome._tag,
					"Stuck",
					`Outcome ${outcome._tag}; subsequent admission ${next._tag}`,
				)
				assert.strictEqual(next._tag, "Failure")
				if (next._tag === "Failure")
					assert.strictEqual(next.failure.reason._tag, "Busy")
			}),
		),
)
