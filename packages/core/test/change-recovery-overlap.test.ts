import { Cause, Context, Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition } from "../src/index.ts"
import { budget, candidate } from "./change-driver.ts"
import { run } from "./utils.ts"

it.effect(
	"recovers a Restart-only previous target after an Overlap trial fails",
	() =>
		run(
			Effect.gen(function* () {
				const failCandidate = yield* Deferred.make<
					void,
					Transition.DriverError
				>()
				const driver: Transition.Driver = {
					name: "controlled",
					overlap: (value) => value.identity === "next",
					allocate: (desired, term, acknowledgement) =>
						Effect.gen(function* () {
							const exited = yield* Deferred.make<Change.Termination>()
							return {
								acknowledgement,
								start: Effect.void,
								describe: Effect.succeed({
									overlap: desired.identity === "next",
									provides: [],
								}),
								serve: Effect.void,
								ready: Effect.succeed(Context.empty()),
								probe: () => Effect.void,
								stop: Effect.void,
								terminate: Deferred.succeed(exited, {
									unit: `recovery-${term}`,
									state: "Exited",
								}).pipe(Effect.asVoid),
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
						name: "recovery-recovery",
						apply: () =>
							Transition.registerDriver(driver, {
								instance: "recovery",
								initial: candidate("old"),
								budget,
								required: [],
								facades: [],
							}),
					}),
				)
				yield* fork.await
				const trial = yield* Change.changes.pipe(
					Stream.filter(
						(status) =>
							status.instance === "recovery" && status.phase === "Trial",
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				const handle = yield* Change.submit({
					instance: "recovery",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
					requirements: { trial: 10 },
				})
				yield* Fiber.join(trial)
				yield* Deferred.fail(
					failCandidate,
					Transition.DriverError.make({
						cause: Cause.fail("Candidate trial failed"),
					}),
				)
				const recoveryTrial = Change.changes.pipe(
					Stream.filter(
						(status) =>
							status.instance === "recovery" &&
							status.phase === "Trial" &&
							status.members[0]?.actual.generation === 3,
					),
					Stream.runHead,
					Effect.andThen(TestClock.adjust(10)),
					Effect.andThen(handle.await),
				)
				yield* Effect.raceFirst(handle.await, recoveryTrial)
				const outcome = yield* handle.await
				assert.strictEqual(
					outcome._tag,
					"Recovered",
					outcome._tag === "RecoveryFailed" ? outcome.reason : outcome._tag,
				)
			}),
		),
)
