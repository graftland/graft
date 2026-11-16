/**
 * Replayed isolation regressions from the 0.6 line: a failed mount never
 * disturbs a healthy sibling that shares its provider, and withdrawing a
 * provider never blocks an unrelated mount that is mid-restart.
 */
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Queue,
	Ref,
	Stream,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Mount } from "../src/index.ts"
import { reach, run } from "./utils.ts"

const causeText = (cause: Cause.Cause<unknown>) => Cause.pretty(cause)

const stateTag = (mount: Mount.Mount) =>
	Stream.runHead(mount.state).pipe(
		Effect.map((state) => Option.getOrThrow(state)._tag),
	)

describe("sibling failure isolation", () => {
	class Shared extends Context.Service<Shared, string>()(
		"@graftland/graft/test/replay-isolation.test/Shared",
	) {}

	interface HealthyService {
		readonly ping: Effect.Effect<string>
	}

	class Healthy extends Context.Service<Healthy, HealthyService>()(
		"@graftland/graft/test/replay-isolation.test/Healthy",
	) {}

	it.effect(
		"keeps a healthy mount and its consumer serving when a sibling fails",
		() =>
			Effect.gen(function* () {
				const fail = yield* Deferred.make<void>()
				const providerBuilds = yield* Ref.make(0)
				const provider = yield* Graft.mount(
					Layer.effect(
						Shared,
						Ref.update(providerBuilds, (count) => count + 1).pipe(
							Effect.as("shared"),
						),
					),
					{ name: "shared provider" },
				)
				yield* provider.await

				const healthyBuilds = yield* Ref.make(0)
				const healthyReleased = yield* Ref.make(false)
				const healthy = yield* Graft.mount(
					Layer.effect(
						Healthy,
						Effect.gen(function* () {
							yield* Ref.update(healthyBuilds, (count) => count + 1)
							yield* Effect.addFinalizer(() => Ref.set(healthyReleased, true))
							yield* Shared
							const requests =
								yield* Queue.unbounded<Deferred.Deferred<string>>()
							yield* Graft.fork(
								Effect.forever(
									Queue.take(requests).pipe(
										Effect.flatMap((reply) => Deferred.succeed(reply, "pong")),
									),
								),
							)
							return {
								ping: Effect.gen(function* () {
									const reply = yield* Deferred.make<string>()
									yield* Queue.offer(requests, reply)
									return yield* Deferred.await(reply)
								}),
							}
						}),
					),
					{ name: "healthy sibling", requires: [Shared] },
				)
				yield* healthy.await

				const consumerBuilds = yield* Ref.make(0)
				const served = yield* Deferred.make<HealthyService>()
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Ref.update(consumerBuilds, (count) => count + 1)
							const healthy = yield* Healthy
							yield* Deferred.succeed(served, healthy)
						}),
					),
					{ name: "healthy consumer", requires: [Healthy] },
				)
				yield* consumer.await

				const failing = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Shared
							yield* Graft.fork(
								Deferred.await(fail).pipe(
									Effect.andThen(Effect.fail("sibling worker failed")),
								),
							)
						}),
					),
					{ name: "failing sibling", requires: [Shared] },
				)
				yield* failing.await

				yield* Deferred.succeed(fail, undefined)
				yield* reach(failing, "Failed")

				// The failing sibling reports its own cause.
				const failed = yield* Effect.exit(failing.await)
				assert.isTrue(Exit.isFailure(failed))
				if (Exit.isFailure(failed))
					assert.include(causeText(failed.cause), "sibling worker failed")

				// Nothing was rebuilt and nothing was torn down.
				const providerBuildCount = yield* Ref.get(providerBuilds)
				const healthyBuildCount = yield* Ref.get(healthyBuilds)
				const consumerBuildCount = yield* Ref.get(consumerBuilds)
				const healthyWasReleased = yield* Ref.get(healthyReleased)
				const providerState = yield* stateTag(provider)
				const healthyState = yield* stateTag(healthy)
				const consumerState = yield* stateTag(consumer)
				assert.strictEqual(providerBuildCount, 1)
				assert.strictEqual(healthyBuildCount, 1)
				assert.strictEqual(consumerBuildCount, 1)
				assert.isFalse(healthyWasReleased)
				assert.strictEqual(providerState, "Active")
				assert.strictEqual(healthyState, "Active")
				assert.strictEqual(consumerState, "Active")

				// The healthy mount's worker and its consumer still serve calls.
				const service = yield* Deferred.await(served)
				const firstPong = yield* service.ping
				assert.strictEqual(firstPong, "pong")

				yield* healthy.stable
				const stableBuildCount = yield* Ref.get(healthyBuilds)
				assert.strictEqual(stableBuildCount, 1)
				const secondPong = yield* service.ping
				assert.strictEqual(secondPong, "pong")

				yield* failing.unmount
				yield* consumer.unmount
				yield* healthy.unmount
				yield* provider.unmount
			}).pipe(run),
	)
})

describe("withdrawal during an unrelated restart", () => {
	class Withdrawn extends Context.Service<Withdrawn, string>()(
		"@graftland/graft/test/replay-isolation.test/Withdrawn",
	) {}

	interface ServingService {
		readonly ping: Effect.Effect<string>
	}

	class Serving extends Context.Service<Serving, ServingService>()(
		"@graftland/graft/test/replay-isolation.test/Serving",
	) {}

	it.effect(
		"does not let withdrawing a provider block an unrelated mount's restart",
		() =>
			Effect.gen(function* () {
				const provider = yield* Graft.mount(Layer.succeed(Withdrawn, "a"), {
					name: "provider A",
				})
				yield* provider.await

				const builds = yield* Ref.make(0)
				const building = yield* Queue.unbounded<number>()
				const gate = yield* Deferred.make<void>()
				const latest = yield* Ref.make<Option.Option<ServingService>>(
					Option.none(),
				)
				const mountB = yield* Graft.mount(
					Layer.effect(
						Serving,
						Effect.gen(function* () {
							const attempt = yield* Ref.updateAndGet(builds, (n) => n + 1)
							yield* Queue.offer(building, attempt)
							// The first build completes immediately; the restart
							// waits for the test to withdraw the provider A.
							if (attempt > 1) yield* Deferred.await(gate)
							const service = { ping: Effect.succeed(`attempt ${attempt}`) }
							yield* Ref.set(latest, Option.some(service))
							return service
						}),
					),
					{ name: "mount B" },
				)
				yield* mountB.await
				// Drain the initial build's entry so the next one is the restart.
				const initialAttempt = yield* Queue.take(building)
				assert.strictEqual(initialAttempt, 1)

				const restarted = yield* Effect.forkScoped(mountB.restart)
				const restartedAttempt = yield* Queue.take(building)
				assert.strictEqual(restartedAttempt, 2)
				const loadingState = yield* stateTag(mountB)
				assert.strictEqual(loadingState, "Loading")

				// Withdrawing the provider finishes while mount B is still
				// blocked inside its restart.
				const withdrawing = yield* Effect.forkScoped(provider.unmount)
				yield* Fiber.join(withdrawing)
				const withdrawnState = yield* stateTag(provider)
				const blockedBuilds = yield* Ref.get(builds)
				const stillLoading = yield* stateTag(mountB)
				assert.strictEqual(withdrawnState, "Unmounted")
				assert.strictEqual(blockedBuilds, 2)
				assert.strictEqual(stillLoading, "Loading")

				// Releasing the restart lets mount B finish on its own terms.
				yield* Deferred.succeed(gate, undefined)
				yield* Fiber.join(restarted)
				yield* reach(mountB, "Active")
				const activeState = yield* stateTag(mountB)
				const finishedBuilds = yield* Ref.get(builds)
				assert.strictEqual(activeState, "Active")
				assert.strictEqual(finishedBuilds, 2)
				const latestService = yield* Ref.get(latest)
				const service = Option.getOrThrow(latestService)
				const pong = yield* service.ping
				assert.strictEqual(pong, "attempt 2")

				yield* mountB.unmount
			}).pipe(run),
	)
})
