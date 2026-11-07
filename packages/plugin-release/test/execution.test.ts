import { Array, Cause, Effect, Ref } from "effect"
import { assert, it } from "@effect/vitest"

import { Transition } from "@graftland/graft"

import { execute } from "../src/internal/execution"

it.effect(
	"stops forward execution and compensates every accepted entry in reverse even after a failed compensation",
	() =>
		Effect.gen(function* () {
			const calls = yield* Ref.make<ReadonlyArray<string>>([])
			const cause = Cause.die("The third entry failed")
			const failed = Transition.Outcome.Aborted({
				phase: "Probing",
				reason: "Failed",
				evidence: [{ attempt: 3, phase: "Probing", cause }],
			})
			const recovery = Transition.Outcome.RecoveryFailed({
				phase: "Recovery",
				reason: "Failed",
				evidence: [],
			})
			const accepted = Transition.Outcome.Accepted({
				phase: "Complete",
				evidence: [],
			})
			const result = yield* execute(
				["first", "second", "third", "fourth"],
				(entry) => entry,
				(entry, compensation) =>
					Ref.update(calls, (calls) => [
						...calls,
						(compensation ? "restore " : "apply ") + entry,
					]).pipe(
						Effect.as(
							compensation
								? entry === "second"
									? recovery
									: accepted
								: entry === "third"
									? failed
									: accepted,
						),
					),
			)
			const observed = yield* Ref.get(calls)
			assert.deepEqual(observed, [
				"apply first",
				"apply second",
				"apply third",
				"restore second",
				"restore first",
			])
			assert.equal(result._tag, "Rejected")
			if (result._tag === "Rejected") assert.isTrue(result.degraded)
			assert.deepEqual(
				Array.map(result.outcomes, (item) => item.outcome),
				[accepted, accepted, failed, recovery, accepted],
			)
			assert.strictEqual(result.outcomes[2]?.outcome.evidence[0]?.cause, cause)
		}),
)

it.effect(
	"accepts every entry without compensation when all outcomes are accepted",
	() =>
		Effect.gen(function* () {
			const result = yield* execute(
				["first", "second"],
				(entry) => entry,
				(_entry, compensation) => {
					assert.isFalse(compensation)
					return Effect.succeed(
						Transition.Outcome.Accepted({ phase: "Complete", evidence: [] }),
					)
				},
			)
			assert.equal(result._tag, "Applying")
			if (result._tag === "Applying")
				assert.deepEqual(result.accepted, ["first", "second"])
		}),
)
