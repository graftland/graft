import { Cause, Clock, Context, Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition, Trust } from "../src/index.ts"
import { normalize } from "../src/internal/changeRequest.ts"
import { remaining } from "../src/internal/transitionBudgets.ts"
import { budget, candidate } from "./change-driver.ts"
import { run } from "./utils.ts"

it.effect(
	"charges preparation cleanup to the same absolute Change deadline",
	() =>
		Effect.gen(function* () {
			const admitted = yield* Deferred.make<void>()
			const testing = yield* run(
				Effect.gen(function* () {
					const failCandidate = yield* Deferred.make<
						void,
						Transition.DriverError
					>()
					const callEntered = yield* Deferred.make<void>()
					class Calls extends Context.Service<
						Calls,
						{
							readonly hold: Effect.Effect<
								void,
								| Transition.DriverError
								| Transition.AdmissionRejected
								| Transition.Unavailable
								| Trust.Unapproved
							>
						}
					>()("@graftland/graft/test/change-total-budget.test/Calls") {}
					const facade =
						yield* Deferred.make<Context.Service.Shape<typeof Calls>>()
					const driver: Transition.Driver = {
						name: "controlled",
						prepare: (desired) =>
							(desired.identity === "next"
								? Effect.addFinalizer(() => Effect.delay(Effect.void, 99))
								: Effect.void
							).pipe(Effect.as({ overlap: true })),
						allocate: (_desired, term, acknowledgement) =>
							Effect.gen(function* () {
								if (term === 3) yield* Effect.delay(Effect.void, 99)
								yield* Effect.addFinalizer(() =>
									Effect.delay(Effect.void, 99).pipe(
										Effect.andThen(
											term === 1
												? Deferred.fail(
														failCandidate,
														Transition.DriverError.make({
															cause: Cause.fail(
																"Candidate failed while old retired",
															),
														}),
													)
												: Effect.void,
										),
									),
								)
								const exited = yield* Deferred.make<Change.Termination>()
								const delayed = <A, E>(effect: Effect.Effect<A, E>) =>
									term === 3 ? Effect.delay(effect, 99) : effect
								return {
									acknowledgement,
									start: delayed(Effect.void),
									describe: delayed(
										Effect.succeed({ overlap: true, provides: [] }),
									),
									serve: delayed(Effect.void),
									ready: delayed(
										Effect.succeed(
											Context.make(Calls, {
												hold: Deferred.succeed(callEntered, undefined).pipe(
													Effect.andThen(Effect.never),
												),
											}),
										),
									),
									probe: () =>
										term === 3
											? Effect.delay(
													Transition.DriverError.make({
														cause: Cause.fail("Recovery probe failed"),
													}),
													99,
												)
											: Effect.void,
									stop: Effect.delay(Effect.void, 99),
									terminate: Effect.delay(
										Deferred.succeed(exited, {
											unit: `budget-${term}`,
											state: "Exited",
										}).pipe(Effect.asVoid),
										99,
									),
									exited: Deferred.await(exited),
									failure:
										term === 2
											? Deferred.await(failCandidate).pipe(
													Effect.andThen(Effect.never),
												)
											: Effect.never,
								}
							}),
					}
					const fork = yield* Graft.plugin(
						Plugin.make({
							name: "deadline-budget",
							apply: () =>
								Transition.registerDriver(driver, {
									instance: "deadline-budget",
									initial: candidate("old"),
									budget,
									required: [],
									facades: [
										Transition.facade(Calls, (invoke) => {
											const value = { hold: invoke((service) => service.hold) }
											return value
										}),
									],
								}),
						}),
					)
					yield* fork.await
					const consumer = yield* Graft.plugin(
						Plugin.make({
							name: "deadline-budget-consumer",
							inject: [Calls],
							apply: () =>
								Effect.flatMap(Calls, (calls) =>
									Deferred.succeed(facade, calls).pipe(Effect.asVoid),
								),
						}),
					)
					yield* consumer.await
					const calls = yield* Deferred.await(facade)
					yield* calls.hold.pipe(Effect.exit, Effect.forkScoped)
					yield* Deferred.await(callEntered)
					const total = 1503
					const started = yield* Clock.monotonicTimeNanos
					const trial = yield* Change.changes.pipe(
						Stream.filter(
							(status) =>
								status.instance === "deadline-budget" &&
								status.phase === "Trial",
						),
						Stream.runHead,
						Effect.forkScoped({ startImmediately: true }),
					)
					const handle = yield* Change.submit({
						instance: "deadline-budget",
						candidate: candidate("next"),
						strategy: "Overlap",
						budget: { ...budget, total },
						requirements: { trial: 1, probes: ["health"] },
					})
					yield* Fiber.join(trial)
					yield* Deferred.succeed(admitted, undefined)
					const waiting = yield* handle.await.pipe(
						Effect.flatMap((outcome) =>
							Clock.monotonicTimeNanos.pipe(
								Effect.map((ended) => ({
									outcome,
									elapsed: Number(ended - started) / 1000000,
								})),
							),
						),
						Effect.forkScoped,
					)
					const result = yield* Fiber.join(waiting)
					assert.strictEqual(
						result.outcome._tag,
						"RecoveryFailed",
						`Observed ${result.outcome._tag} after ${result.elapsed}ms`,
					)
					assert.isAtMost(
						result.elapsed,
						total,
						`Outcome ${result.outcome._tag} after ${result.elapsed}ms exceeds total ${total}ms`,
					)
				}),
			).pipe(Effect.forkScoped)
			yield* Deferred.await(admitted)
			yield* TestClock.adjust(10000)
			yield* Fiber.join(testing)
		}),
)

it.effect(
	"rejects a total budget that omits the required metadata cleanup reserve",
	() =>
		Effect.gen(function* () {
			const rejection = yield* normalize({
				instance: "deadline",
				candidate: candidate("next"),
				budget: { ...budget, total: 1403 },
				requirements: { trial: 1, probes: ["health"] },
			}).pipe(Effect.flip)
			assert.equal(rejection.reason._tag, "InvalidBudget")
			const valid = yield* normalize({
				instance: "deadline",
				candidate: candidate("next"),
				budget: { ...budget, total: 1503 },
				requirements: { trial: 1, probes: ["health"] },
			})
			assert.equal(valid.budget.total, 1503)
		}),
)

it.effect(
	"caps cleanup waiting at the original absolute deadline even when its operation budget is larger",
	() =>
		Effect.gen(function* () {
			const started = yield* Clock.monotonicTimeNanos
			yield* TestClock.adjust(95)
			const before = yield* remaining(started, 100, 30)
			assert.equal(before, 5)
			yield* TestClock.adjust(10)
			const expired = yield* remaining(started, 100, 30)
			assert.equal(expired, 0)
		}),
)
