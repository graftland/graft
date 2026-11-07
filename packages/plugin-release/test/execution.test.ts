import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Option,
	Ref,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition } from "@graftland/graft"

import { execute } from "../src/internal/execution"

it.effect(
	"stops forward execution and compensates every accepted entry in reverse even after a failed compensation",
	() =>
		Effect.gen(function* () {
			const calls = yield* Ref.make<ReadonlyArray<string>>([])
			const cause = Cause.die("The third entry failed")
			const failed = Change.Outcome.Aborted({
				change: Change.Id.make("fixture"),
				members: [],
				phase: "Probing",
				reason: "Failed",
				evidence: [{ attempt: 3, phase: "Probing", cause }],
			})
			const recovery = Change.Outcome.RecoveryFailed({
				change: Change.Id.make("fixture"),
				members: [],
				phase: "Recovery",
				reason: "Failed",
				evidence: [],
			})
			const accepted = Change.Outcome.Accepted({
				change: Change.Id.make("fixture"),
				members: [
					Option.getOrThrow(Array.head(acceptedAt("first", 2).members)),
					Option.getOrThrow(Array.head(acceptedAt("second", 2).members)),
				],
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
				Array.map(result.outcomes, (item) =>
					item._tag === "Admitted" ? item.outcome : undefined,
				),
				[accepted, accepted, failed, recovery, accepted],
			)
			assert.strictEqual(
				result.outcomes[2]?._tag === "Admitted"
					? result.outcomes[2].outcome.evidence[0]?.cause
					: undefined,
				cause,
			)
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
						Change.Outcome.Accepted({
							change: Change.Id.make("fixture"),
							members: [],
							phase: "Complete",
							evidence: [],
						}),
					)
				},
			)
			assert.equal(result._tag, "Applying")
			if (result._tag === "Applying")
				assert.deepEqual(result.accepted, ["first", "second"])
		}),
)

const acceptedAt = (instance: string, version: number) =>
	Change.Outcome.Accepted({
		change: Change.Id.make(`change-${instance}-${version}`),
		phase: "Complete",
		evidence: [],
		members: [
			{
				instance,
				selection: "Requested",
				starting: { version: version - 1, health: "Serving" },
				desired: {
					candidate: { driver: "fixture", identity: instance, deployment: {} },
					version,
				},
				execution: Change.Execution.Completed({
					phase: "Complete",
					outcome: "Accepted",
				}),
				compensation: "NotNeeded",
				actual: {
					version,
					generation: version,
					health: "Serving",
					matchesTarget: true,
				},
				recoverability: {
					possible: true,
					reason: "The previous desired target can be resolved again",
				},
			},
		],
	})

it.effect(
	"compensates an accepted entry when the next request is rejected before admission",
	() =>
		Effect.gen(function* () {
			const calls = yield* Ref.make<ReadonlyArray<string>>([])
			const rejection = Change.ChangeRejected.make({
				reason: { _tag: "Closing" },
			})
			const result = yield* execute(
				["a", "b", "c"],
				(entry) => entry,
				(entry, compensation) =>
					Ref.update(
						calls,
						Array.append(`${compensation ? "restore" : "apply"} ${entry}`),
					).pipe(
						Effect.andThen(
							entry === "b"
								? rejection
								: Effect.succeed(acceptedAt(entry, compensation ? 3 : 2)),
						),
					),
			)
			assert.strictEqual(result._tag, "Rejected")
			const observed = yield* Ref.get(calls)
			assert.deepStrictEqual(observed, ["apply a", "apply b", "restore a"])
			assert.strictEqual(result.outcomes[1]?._tag, "Rejected")
			const rejected = result.outcomes[1]
			if (rejected?._tag === "Rejected")
				assert.strictEqual(rejected.rejection, rejection)
		}),
)

it.effect(
	"passes the accepted version to compensation and preserves a later accepted change on conflict",
	() =>
		Effect.gen(function* () {
			const current = yield* Ref.make(4)
			const expectedVersions = yield* Ref.make<
				ReadonlyArray<number | undefined>
			>([])
			const result = yield* execute(
				["a", "b"],
				(entry) => entry,
				(entry, compensation, expected) =>
					Effect.gen(function* () {
						if (!compensation)
							return entry === "a"
								? acceptedAt(entry, 3)
								: yield* Change.ChangeRejected.make({
										reason: { _tag: "Closing" },
									})
						yield* Ref.update(expectedVersions, Array.append(expected))
						const actual = yield* Ref.get(current)
						if (expected !== actual)
							return yield* Change.ChangeRejected.make({
								reason: {
									_tag: "Stale",
									object: { _tag: "Instance", instance: entry },
									expected: expected ?? -1,
									actual,
								},
							})
						yield* Ref.set(current, actual + 1)
						return acceptedAt(entry, actual + 1)
					}),
			)
			assert.strictEqual(result._tag, "Rejected")
			if (result._tag === "Rejected") assert.isTrue(result.degraded)
			const expected = yield* Ref.get(expectedVersions)
			assert.deepStrictEqual(expected, [3])
			const retained = yield* Ref.get(current)
			assert.strictEqual(retained, 4)
			const compensation = Option.getOrThrow(Array.last(result.outcomes))
			assert.strictEqual(compensation._tag, "Rejected")
			if (compensation._tag === "Rejected")
				assert.strictEqual(compensation.rejection.reason._tag, "Stale")
		}),
)

it.effect(
	"uses production admission to reject B and fences compensation from a later accepted Change",
	() =>
		Effect.gen(function* () {
			const allocations = yield* Ref.make<ReadonlyArray<string>>([])
			const target = (identity: string): Change.Candidate => ({
				driver: "release-proof",
				identity,
				deployment: { identity },
			})
			const driver: Transition.Driver = {
				name: "release-proof",
				allocate: (candidate, generation, acknowledgement) =>
					Effect.gen(function* () {
						yield* Ref.update(allocations, Array.append(candidate.identity))
						const exit = yield* Deferred.make<Change.Termination>()
						const stop = Deferred.succeed(exit, {
							unit: `unit-${generation}`,
							state: "Exited",
						}).pipe(Effect.asVoid)
						return {
							acknowledgement,
							start: Effect.void,
							describe: Effect.succeed({ overlap: false, provides: [] }),
							serve: Effect.void,
							ready: Effect.succeed(Context.empty()),
							probe: () => Effect.void,
							stop,
							terminate: stop,
							exited: Deferred.await(exit),
							failure: Effect.never,
						}
					}),
			}
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "release-proof",
					apply: () =>
						Transition.registerDriver(driver, {
							instance: "a",
							initial: target("old"),
							required: [],
							facades: [],
						}),
				}),
			)
			yield* fork.await
			const result = yield* execute(
				["a", "b"],
				(entry) => entry,
				(entry, compensation, expected) =>
					Effect.gen(function* () {
						if (entry === "b") {
							const later = yield* Change.run({
								instance: "a",
								candidate: target("later"),
							})
							assert.strictEqual(later._tag, "Accepted")
							return yield* Change.run({
								instance: "missing",
								candidate: target("missing"),
							})
						}
						return yield* Change.run({
							instance: entry,
							candidate: target(compensation ? "old" : "next"),
							expected,
						})
					}),
			)
			assert.strictEqual(result._tag, "Rejected")
			if (result._tag === "Rejected") assert.isTrue(result.degraded)
			const rejected = result.outcomes[1]
			assert.strictEqual(rejected?._tag, "Rejected")
			if (rejected?._tag === "Rejected")
				assert.strictEqual(rejected.rejection.reason._tag, "UnsupportedTarget")
			const compensation = result.outcomes[2]
			assert.strictEqual(compensation?._tag, "Rejected")
			if (compensation?._tag === "Rejected") {
				assert.strictEqual(compensation.rejection.reason._tag, "Stale")
				if (compensation.rejection.reason._tag === "Stale") {
					assert.strictEqual(compensation.rejection.reason.expected, 2)
					assert.strictEqual(compensation.rejection.reason.actual, 3)
				}
			}
			const started = yield* Ref.get(allocations)
			assert.deepStrictEqual(started, ["old", "next", "later"])
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"reports a missing accepted member as an explicit compensation invariant defect",
	() =>
		Effect.gen(function* () {
			const result = yield* Effect.exit(
				execute(
					["first", "second"],
					(entry) => entry,
					(entry) =>
						entry === "first"
							? Effect.succeed(
									Change.Outcome.Accepted({
										change: Change.Id.make("missing-member"),
										members: [],
										phase: "Complete",
										evidence: [],
									}),
								)
							: Change.ChangeRejected.make({
									reason: { _tag: "UnsupportedTarget", instance: entry },
								}),
				),
			)
			assert.isTrue(Exit.isFailure(result))
			if (Exit.isFailure(result)) {
				const defect = Cause.squash(result.cause)
				assert.instanceOf(defect, Error)
				assert.strictEqual(
					defect instanceof Error ? defect.message : undefined,
					"Compensation requires an accepted member matching the entry",
				)
			}
		}),
)
