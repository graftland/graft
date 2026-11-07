import { Array, Cause, Effect, Fiber, Option, Stream, TxRef } from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change, Trust } from "../src/index.ts"
import { budget, candidate, register } from "./change-driver.ts"
import { run } from "./utils.ts"

for (const mode of ["approved", "revoked", "changed"] as const)
	it.effect(
		mode === "approved"
			? "recovers an independently authorized previous target after candidate authorization changes"
			: mode === "revoked"
				? "refuses recovery when the previous target is no longer authorized"
				: "invalidates recovery when its own authorization premise changes during trial",
		() =>
			run(
				Effect.gen(function* () {
					const revision = yield* TxRef.make({
						candidate: 0,
						previous: 0,
						approved: true,
					})
					yield* Trust.register({
						compare: (_entry, identity) =>
							TxRef.get(revision).pipe(
								Effect.map((revision) => ({
									revision:
										identity === "next"
											? revision.candidate
											: revision.previous,
									current: "approved",
									approved:
										identity === "old" && !revision.approved
											? Option.none()
											: Option.some("approved"),
									missing: "Missing",
								})),
							),
						publish: () => Effect.void,
					})
					yield* register("a")
					const trial = yield* Change.changes.pipe(
						Stream.filter(
							(status) => status.instance === "a" && status.phase === "Trial",
						),
						Stream.runHead,
						Effect.forkScoped({ startImmediately: true }),
					)
					const recoveryTrial = yield* Change.changes.pipe(
						Stream.filter(
							(status) =>
								status.instance === "a" &&
								status.phase === "Trial" &&
								Array.some(
									status.evidence,
									(item) => item.attempt === 3 && item.phase === "Readiness",
								),
						),
						Stream.runHead,
						Effect.forkScoped({ startImmediately: true }),
					)
					const handle = yield* Change.submit({
						instance: "a",
						candidate: candidate("next"),
						budget,
						requirements: { trial: 100 },
					})
					yield* Fiber.join(trial)
					yield* TxRef.update(revision, (value) => ({
						...value,
						candidate: 1,
						approved: mode !== "revoked",
					}))
					const outcome = yield* Effect.raceFirst(
						handle.await,
						Fiber.join(recoveryTrial).pipe(
							Effect.andThen(
								mode === "changed"
									? TxRef.update(revision, (value) => ({
											...value,
											previous: 1,
										}))
									: TestClock.adjust(100),
							),
							Effect.andThen(handle.await),
						),
					)
					assert.strictEqual(
						outcome._tag,
						mode === "approved" ? "Recovered" : "RecoveryFailed",
						Array.join(
							Array.map(
								outcome.evidence,
								(item) =>
									`${item.attempt} ${item.phase}: ${item.cause === undefined ? "ok" : Cause.pretty(item.cause)}`,
							),
							"\n",
						),
					)
				}),
			),
	)
