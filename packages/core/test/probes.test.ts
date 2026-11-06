import { Cause, Deferred, Effect, Exit, Fiber, Ref, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "../src/index"

it.effect(
	"registers probes without running them and replaces them with each attempt",
	() =>
		Effect.gen(function* () {
			const calls = yield* Ref.make<ReadonlyArray<number>>([])
			const plugin = Plugin.make({
				name: "probed",
				config: Schema.Finite,
				apply: (value) =>
					Plugin.probe(
						"health",
						Ref.update(calls, (values) => [...values, value]),
					),
			})
			const fork = yield* Graft.plugin(plugin, 1)
			yield* fork.await
			const observed1 = yield* Ref.get(calls)
			assert.deepEqual(observed1, [])
			const observed2 = yield* fork.probes
			assert.deepEqual(observed2, ["health"])
			yield* fork.probe("health")
			yield* fork.update(2)
			yield* fork.await
			yield* fork.probe("health")
			const observed3 = yield* Ref.get(calls)
			assert.deepEqual(observed3, [1, 2])
			yield* fork.dispose
			const observed4 = yield* fork.probes
			assert.deepEqual(observed4, [])
			const observed5 = yield* Effect.flip(fork.probe("health"))
			assert.equal(observed5.reason, "Missing")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"isolates probe registries between forks and preserves the failure cause",
	() =>
		Effect.gen(function* () {
			const good = yield* Graft.plugin(
				Plugin.make({
					name: "good",
					apply: () => Plugin.probe("health", Effect.void),
				}),
			)
			const bad = yield* Graft.plugin(
				Plugin.make({
					name: "bad",
					apply: () =>
						Plugin.probe(
							"health",
							Effect.failCause(
								Cause.combine(
									Cause.fail("unhealthy"),
									Cause.die("probe defect"),
								),
							),
						),
				}),
			)
			yield* good.await
			yield* bad.await
			yield* good.probe("health")
			const failure = yield* Effect.flip(bad.probe("health"))
			assert.equal(failure.reason, "Failed")
			assert(failure.cause !== undefined)
			assert.include(Cause.pretty(failure.cause), "unhealthy")
			assert.include(Cause.pretty(failure.cause), "probe defect")
			yield* good.probe("health")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"closes each probe request scope and interrupts probes when their attempt stops",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const finalized = yield* Ref.make(0)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "scoped-probe",
					apply: () =>
						Effect.gen(function* () {
							yield* Plugin.probe(
								"short",
								Effect.addFinalizer(() => Ref.update(finalized, (n) => n + 1)),
							)
							yield* Plugin.probe(
								"waiting",
								Effect.acquireRelease(
									Deferred.succeed(started, undefined),
									() => Ref.update(finalized, (n) => n + 1),
								).pipe(Effect.andThen(Effect.never)),
							)
						}),
				}),
			)
			yield* fork.await
			yield* fork.probe("short")
			const observed6 = yield* Ref.get(finalized)
			assert.equal(observed6, 1)
			const request = yield* fork.probe("waiting").pipe(Effect.forkScoped)
			yield* Deferred.await(started)
			yield* fork.dispose
			yield* Fiber.await(request)
			const observed7 = yield* Ref.get(finalized)
			assert.equal(observed7, 2)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("rejects duplicate probe names within an attempt", () =>
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "duplicate-probes",
				apply: () =>
					Effect.gen(function* () {
						yield* Plugin.probe("health", Effect.void)
						yield* Plugin.probe("health", Effect.void)
					}),
			}),
		)
		const failure = yield* Effect.flip(fork.await)
		assert.equal(failure._tag, "ProbeError")
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"cancels one probe invocation without removing its registration",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const cleaned = yield* Ref.make(false)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "cancel-probe",
					apply: () =>
						Plugin.probe(
							"waiting",
							Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
								Ref.set(cleaned, true),
							).pipe(Effect.andThen(Effect.never)),
						),
				}),
			)
			yield* fork.await
			const request = yield* fork.probe("waiting").pipe(Effect.forkScoped)
			yield* Deferred.await(started)
			yield* Fiber.interrupt(request)
			const finalized = yield* Ref.get(cleaned)
			assert.isTrue(finalized)
			const names = yield* fork.probes
			assert.deepEqual(names, ["waiting"])
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("retains probe cleanup defects when a request is cancelled", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "probe-cleanup",
				apply: () =>
					Plugin.probe(
						"waiting",
						Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
							Effect.die("Probe cleanup failed"),
						).pipe(Effect.andThen(Effect.never)),
					),
			}),
		)
		yield* fork.await
		const request = yield* fork.probe("waiting").pipe(Effect.forkScoped)
		yield* Deferred.await(started)
		yield* Fiber.interrupt(request)
		const result = yield* Fiber.await(request)
		assert(Exit.isFailure(result))
		assert.isTrue(Cause.hasDies(result.cause))
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
