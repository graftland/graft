import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Fiber,
	Option,
	Ref,
	Schedule,
	Scope,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "../src/index.ts"
import { makeJournal, reach, run } from "./utils.ts"

const version = (
	name: string,
	record: (event: string) => Effect.Effect<void>,
	apply: Effect.Effect<void, string> = Effect.void,
) =>
	Plugin.make({
		name,
		apply: () =>
			Effect.acquireRelease(record(`${name} up`), () =>
				record(`${name} down`),
			).pipe(Effect.andThen(apply)),
	})

/** The names of the plugins running now, in fork order. */
const running = Effect.map(Stream.runHead(Graft.forks), (tree) =>
	Array.map(Option.getOrThrow(tree), (node) => node.name),
)

/** The failures of a replacement that must have rolled back. */
const rolledBack = <E, R>(replace: Effect.Effect<Graft.ReplaceResult, E, R>) =>
	Effect.map(replace, (result) => {
		assert.strictEqual(result._tag, "RolledBack")
		return result._tag === "RolledBack" ? result.failures : []
	})

/** A plugin whose error bound admits the failures of its replacements. */
const quiet = (name: string) =>
	Plugin.make({ name, apply: (): Effect.Effect<void, string> => Effect.void })

class Store extends Context.Service<Store, string>()(
	"@graftland/graft/test/replacement-rollback.test/Store",
) {}

describe("replacement rollback", () => {
	it.effect("keeps a replacement that starts", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const v1 = version("v1", journal.record)
			const v2 = version("v2", journal.record)
			const fork = yield* Graft.plugin(v1)
			yield* fork.await
			const result = yield* Graft.replace([[v1, v2]])
			assert.strictEqual(result._tag, "Replaced")
			yield* journal.expect(["v1 up", "v1 down", "v2 up"])
		}).pipe(run),
	)

	it.effect("goes back to the old plugin when the new one fails", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const v1 = version("v1", journal.record)
			const v2 = version("v2", journal.record, Effect.fail("broken"))
			const fork = yield* Graft.plugin(v1)
			yield* fork.await
			const failures = yield* rolledBack(Graft.replace([[v1, v2]]))
			assert.strictEqual(failures.length, 1)
			const [failure] = failures
			assert.strictEqual(failure?._tag, "Failed")
			if (failure?._tag === "Failed") {
				assert.strictEqual(failure.fork, fork.id)
				assert.strictEqual(failure.plugin, "v2")
				assert.include(Cause.pretty(failure.cause), "broken")
			}
			yield* reach(fork, "Active")
			// Loading the old plugin later loads the old plugin again.
			const later = yield* Graft.plugin(v1)
			yield* later.await
			const names = yield* running
			assert.deepStrictEqual(names, ["v1", "v1"])
			yield* journal.expect([
				"v1 up",
				"v1 down",
				"v2 up",
				"v2 down",
				"v1 up",
				"v1 up",
			])
		}).pipe(run),
	)

	it.effect(
		"reports every restored failure with its fork, plugin and full cause",
		() =>
			Effect.gen(function* () {
				const restored = yield* Effect.forEach(["old-a", "old-b"], (name) =>
					Effect.gen(function* () {
						const runs = yield* Ref.make(0)
						const cause = Cause.combine(
							Cause.fail(`${name} failed`),
							Cause.die(`${name} defect`),
						)
						const plugin = Plugin.make({
							name,
							apply: () =>
								Effect.gen(function* () {
									if ((yield* Ref.updateAndGet(runs, (n) => n + 1)) > 1)
										return yield* Effect.failCause(cause)
								}),
						})
						const fork = yield* Graft.plugin(plugin)
						yield* fork.await
						return { plugin, fork, cause }
					}),
				)
				const replacementCause = Cause.combine(
					Cause.fail("replacement failed"),
					Cause.die("replacement defect"),
				)
				const broken = Plugin.make({
					name: "broken",
					apply: () => Effect.failCause(replacementCause),
				})
				const result = yield* Graft.replace(
					Array.map(restored, ({ plugin }) => [plugin, broken] as const),
				)
				assert(result._tag === "RecoveryFailed")
				assert.isNotEmpty(result.failures)
				for (const failure of result.failures) {
					assert(failure._tag === "Failed")
					assert.strictEqual(failure.plugin, "broken")
					assert.strictEqual(failure.cause.reasons.length, 2)
					assert.deepInclude(failure.cause.reasons[0], {
						_tag: "Fail",
						error: "replacement failed",
					})
					assert.deepInclude(failure.cause.reasons[1], {
						_tag: "Die",
						defect: "replacement defect",
					})
				}
				assert.strictEqual(result.recovery.length, restored.length)
				for (const { plugin, fork } of restored) {
					const snapshot = yield* Stream.runHead(fork.state)
					const state = Option.getOrThrow(snapshot)
					assert(state._tag === "Failed")
					const failure = Array.findFirst(
						result.recovery,
						(failure) => failure.fork === fork.id,
					)
					assert.deepStrictEqual(
						Option.getOrThrow(failure),
						Graft.ReplacementFailure.Failed({
							fork: fork.id,
							plugin: plugin.name,
							cause: state.cause,
						}),
					)
					assert.strictEqual(state.cause.reasons.length, 2)
					assert.deepInclude(state.cause.reasons[0], {
						_tag: "Fail",
						error: `${plugin.name} failed`,
					})
					assert.deepInclude(state.cause.reasons[1], {
						_tag: "Die",
						defect: `${plugin.name} defect`,
					})
				}
			}).pipe(run),
	)

	it.effect.each(["dispose", "restart", "replace"] as const)(
		"does not count a restored fork after a later %s takes it over",
		(action) =>
			Effect.gen(function* () {
				const runs = yield* Ref.make(0)
				const recovering = yield* Deferred.make<void>()
				const old = Plugin.make({
					name: "old",
					apply: () =>
						Effect.gen(function* () {
							const run = yield* Ref.updateAndGet(runs, (n) => n + 1)
							if (run === 2) {
								yield* Deferred.succeed(recovering, undefined)
								return yield* Effect.never
							}
							if (run > 2) return yield* Effect.fail("later restart failed")
						}),
				})
				const broken = Plugin.make({
					name: "broken",
					apply: () => Effect.fail("replacement failed"),
				})
				const fork = yield* Graft.plugin(old)
				yield* fork.await
				const replacing = yield* Graft.replace([[old, broken]]).pipe(
					Effect.forkScoped,
				)
				yield* Deferred.await(recovering)
				if (action === "dispose") yield* fork.dispose
				else if (action === "restart") {
					yield* fork.restart
					yield* reach(fork, "Failed")
				} else {
					const result = yield* Graft.replace([[old, quiet("later")]])
					assert.strictEqual(result._tag, "Replaced")
				}
				const result = yield* Fiber.join(replacing)
				assert.strictEqual(result._tag, "RolledBack")
			}).pipe(run),
	)

	it.effect("counts a restored pending fork as rolled back", () =>
		Effect.gen(function* () {
			const old = Plugin.make({
				name: "waiting",
				inject: [Store],
				apply: (): Effect.Effect<void, string> => Effect.void,
			})
			const broken = Plugin.make({
				name: "broken",
				apply: () => Effect.fail("replacement failed"),
			})
			const fork = yield* Graft.plugin(old)
			yield* reach(fork, "Pending")
			const failures = yield* rolledBack(Graft.replace([[old, broken]]))
			assert.strictEqual(failures[0]?.plugin, "broken")
			yield* reach(fork, "Pending")
		}).pipe(run),
	)

	it.effect("rolls back every pair of a batch when one fails", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const a1 = version("a1", journal.record)
			const a2 = version("a2", journal.record)
			const b1 = version("b1", journal.record)
			const b2 = version("b2", journal.record, Effect.fail("broken"))
			const a = yield* Graft.plugin(a1)
			const b = yield* Graft.plugin(b1)
			yield* a.await
			yield* b.await
			const failures = yield* rolledBack(
				Graft.replace([
					[a1, a2],
					[b1, b2],
				]),
			)
			assert.deepStrictEqual(
				Array.map(failures, (failure) => failure.plugin),
				["b2"],
			)
			yield* reach(a, "Active")
			yield* reach(b, "Active")
			const names = yield* running
			assert.deepStrictEqual(names, ["a1", "b1"])
		}).pipe(run),
	)

	it.effect("counts a pending replacement as started", () =>
		Effect.gen(function* () {
			const v1 = quiet("v1")
			const v2 = Plugin.make({
				name: "v2",
				inject: [Store],
				apply: () => Effect.void,
			})
			const fork = yield* Graft.plugin(v1)
			yield* fork.await
			const result = yield* Graft.replace([[v1, v2]])
			assert.strictEqual(result._tag, "Replaced")
			yield* reach(fork, "Pending")
		}).pipe(run),
	)

	it.effect("does not judge a fork that had already failed", () =>
		Effect.gen(function* () {
			const v1 = Plugin.make({
				name: "v1",
				apply: () => Effect.fail("old failure"),
			})
			const v2 = Plugin.make({
				name: "v2",
				apply: () => Effect.fail("new failure"),
			})
			const fork = yield* Graft.plugin(v1)
			yield* Effect.exit(fork.await)
			const result = yield* Graft.replace([[v1, v2]])
			assert.strictEqual(result._tag, "Replaced")
			// The fork restarts with the replacement and fails again.
			const states = yield* Graft.forks.pipe(
				Stream.map(Array.map((node) => `${node.name} ${node.state._tag}`)),
				Stream.filter((names) => names[0] === "v2 Failed"),
				Stream.runHead,
			)
			assert.deepStrictEqual(states, Option.some(["v2 Failed"]))
		}).pipe(run),
	)

	it.effect("rolls back a fork that had failed with the others", () =>
		Effect.gen(function* () {
			const a1 = Plugin.make({ name: "a1", apply: () => Effect.fail("old") })
			const a2 = quiet("a2")
			const b1 = quiet("b1")
			const b2 = Plugin.make({ name: "b2", apply: () => Effect.fail("new") })
			const a = yield* Graft.plugin(a1)
			const b = yield* Graft.plugin(b1)
			yield* Effect.exit(a.await)
			yield* b.await
			const result = yield* Graft.replace([
				[a1, a2],
				[b1, b2],
			])
			assert(result._tag === "RecoveryFailed")
			assert.deepStrictEqual(
				Array.map(result.failures, (failure) => failure.plugin),
				["b2"],
			)
			const snapshot = yield* Stream.runHead(a.state)
			const state = Option.getOrThrow(snapshot)
			assert(state._tag === "Failed")
			assert.deepStrictEqual(result.recovery, [
				Graft.ReplacementFailure.Failed({
					fork: a.id,
					plugin: "a1",
					cause: state.cause,
				}),
			])
			yield* reach(b, "Active")
			const names = yield* running
			assert.deepStrictEqual(names, ["a1", "b1"])
		}).pipe(run),
	)

	it.effect("judges a child that a replaced parent loads", () =>
		Effect.gen(function* () {
			const child1 = quiet("child1")
			const child2 = Plugin.make({
				name: "child2",
				apply: () => Effect.fail("broken child"),
			})
			const parent = (name: string, child: Plugin.Plugin<void, void, string>) =>
				Plugin.make({
					name,
					apply: () => Effect.asVoid(Graft.plugin(child)),
				})
			const parent1 = parent("parent1", child1)
			const parent2 = parent("parent2", child2)
			const fork = yield* Graft.plugin(parent1)
			yield* fork.stable
			const failures = yield* rolledBack(
				Graft.replace([
					[parent1, parent2],
					[child1, child2],
				]),
			)
			assert.deepStrictEqual(
				Array.map(failures, (failure) => failure.plugin),
				["child2"],
			)
			yield* reach(fork, "Active")
			yield* fork.stable
			const tree = yield* Stream.runHead(Graft.forks)
			const [root] = Option.getOrThrow(tree)
			assert.strictEqual(root?.name, "parent1")
			assert.deepStrictEqual(
				Array.map(root?.children ?? [], (node) => node.name),
				["child1"],
			)
		}).pipe(run),
	)

	it.effect("decides on the first failure of a plugin that retries", () =>
		Effect.gen(function* () {
			const v1 = quiet("v1")
			const v2 = Plugin.make({
				name: "v2",
				apply: () => Effect.fail("broken"),
				retry: Schedule.spaced("1 hour"),
			})
			const fork = yield* Graft.plugin(v1)
			yield* fork.await
			const failures = yield* rolledBack(Graft.replace([[v1, v2]]))
			assert.strictEqual(failures[0]?._tag, "Failed")
			yield* reach(fork, "Active")
		}).pipe(run),
	)

	it.live("rolls back a replacement that does not start in time", () =>
		Effect.gen(function* () {
			const v1 = quiet("v1")
			const v2 = Plugin.make({ name: "v2", apply: () => Effect.never })
			const fork = yield* Graft.plugin(v1)
			yield* fork.await
			const failures = yield* rolledBack(
				Graft.replace([[v1, v2]], { timeout: "50 millis" }),
			)
			assert.deepStrictEqual(failures, [
				Graft.ReplacementFailure.TimedOut({ fork: fork.id, plugin: "v2" }),
			])
			yield* reach(fork, "Active")
			const names = yield* running
			assert.deepStrictEqual(names, ["v1"])
		}).pipe(run),
	)

	it.effect("keeps the swap when the wait is interrupted", () =>
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>()
			const v1 = quiet("v1")
			const v2 = Plugin.make({
				name: "v2",
				apply: () =>
					Effect.andThen(Deferred.await(release), Effect.fail("late")),
			})
			const fork = yield* Graft.plugin(v1)
			yield* fork.await
			const waiting = yield* Effect.forkChild(Graft.replace([[v1, v2]]))
			yield* reach(fork, "Loading")
			yield* Fiber.interrupt(waiting)
			yield* Deferred.succeed(release, undefined)
			yield* reach(fork, "Failed")
			const names = yield* running
			assert.deepStrictEqual(names, ["v2"])
		}).pipe(run),
	)

	it.effect("leaves a fork alone once a later replacement takes it over", () =>
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>()
			const v1 = quiet("v1")
			const v2 = Plugin.make({
				name: "v2",
				apply: () =>
					Effect.andThen(Deferred.await(release), Effect.fail("old")),
			})
			const v3 = quiet("v3")
			const fork = yield* Graft.plugin(v1)
			yield* fork.await
			const first = yield* Effect.forkChild(Graft.replace([[v1, v2]]))
			yield* reach(fork, "Loading")
			const second = yield* Graft.replace([[v2, v3]])
			assert.strictEqual(second._tag, "Replaced")
			const result = yield* Fiber.join(first)
			assert.strictEqual(result._tag, "Replaced")
			yield* Deferred.succeed(release, undefined)
			yield* reach(fork, "Active")
			const names = yield* running
			assert.deepStrictEqual(names, ["v3"])
		}).pipe(run),
	)

	it.effect("restarts dependents on the way in and on the way back", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const store = (name: string, apply: Effect.Effect<void, string>) =>
				Plugin.make({
					name,
					apply: () => Effect.andThen(apply, Graft.provide(Store, name)),
				})
			const store1 = store("store1", Effect.void)
			const store2 = store("store2", Effect.fail("broken"))
			const consumer = Plugin.make({
				name: "consumer",
				inject: [Store],
				apply: () =>
					Effect.flatMap(Store, (value) =>
						Effect.acquireRelease(journal.record(`uses ${value}`), () =>
							journal.record(`drops ${value}`),
						),
					),
			})
			const provider = yield* Graft.plugin(store1)
			const dependent = yield* Graft.plugin(consumer)
			yield* provider.await
			yield* dependent.await
			const failures = yield* rolledBack(Graft.replace([[store1, store2]]))
			assert.strictEqual(failures.length, 1)
			yield* reach(provider, "Active")
			yield* reach(dependent, "Active")
			yield* journal.expect(["uses store1", "drops store1", "uses store1"])
		}).pipe(run),
	)

	it.effect("fails with a conflict before changing anything", () =>
		Effect.gen(function* () {
			const p = quiet("p")
			const q = quiet("q")
			const r = quiet("r")
			const fork = yield* Graft.plugin(p)
			yield* fork.await
			const error = yield* Effect.flip(
				Graft.replace([
					[p, q],
					[q, r],
				]),
			)
			assert.strictEqual(error._tag, "ReplacementConflict")
			const names = yield* running
			assert.deepStrictEqual(names, ["p"])
		}).pipe(run),
	)
})

it.effect("counts failing descendants created by the restored parent", () =>
	Effect.gen(function* () {
		const starts = yield* Ref.make(0)
		const restored = yield* Deferred.make<void>()
		const release = yield* Deferred.make<void>()
		const cause = Cause.combine(
			Cause.fail("restored child failed"),
			Cause.die("restored child defect"),
		)
		const child = Plugin.make({
			name: "restored-child",
			apply: () =>
				Ref.updateAndGet(starts, (n) => n + 1).pipe(
					Effect.flatMap((n) =>
						n > 1
							? Deferred.succeed(restored, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
									Effect.andThen(Effect.failCause(cause)),
								)
							: Effect.void,
					),
				),
		})
		const parent = Plugin.make({
			name: "restored-parent",
			apply: (): Effect.Effect<void, string, Graft.Graft | Scope.Scope> =>
				Graft.plugin(child).pipe(Effect.asVoid),
		})
		const broken = Plugin.make({
			name: "broken-parent",
			apply: () => Effect.fail("replacement failed"),
		})
		const fork = yield* Graft.plugin(parent)
		yield* fork.stable
		const pending = yield* Effect.forkScoped(Graft.replace([[parent, broken]]))
		yield* Deferred.await(restored)
		yield* Effect.yieldNow
		assert.isUndefined(pending.pollUnsafe())
		yield* Deferred.succeed(release, undefined)
		const result = yield* Fiber.join(pending)
		assert.equal(result._tag, "RecoveryFailed")
		if (result._tag === "RecoveryFailed") {
			assert.equal(result.recovery.length, 1)
			const failure = result.recovery[0]
			assert.equal(failure?.plugin, "restored-child")
			if (failure?._tag === "Failed") {
				assert.deepEqual(
					Array.map(failure.cause.reasons, (reason) => reason._tag),
					["Fail", "Die"],
				)
				assert.include(Cause.pretty(failure.cause), "restored child failed")
				assert.include(Cause.pretty(failure.cause), "restored child defect")
			}
		}
	}).pipe(run),
)

for (const action of ["restart", "replace"] as const) {
	for (const descendant of [false, true]) {
		for (const loading of [false, true]) {
			it.effect(
				`excludes a recreated child's ${action} takeover and its ${loading ? "loading" : "failed"} ${descendant ? "subtree" : "attempt"}`,
				() =>
					Effect.gen(function* () {
						const childRuns = yield* Ref.make(0)
						const parentRuns = yield* Ref.make(0)
						const recreated =
							yield* Deferred.make<
								Pick<import("../src/Fork").Fork, "restart">
							>()
						const recovering = yield* Deferred.make<void>()
						const takeoverStarted = yield* Deferred.make<void>()
						const parentRelease = yield* Deferred.make<void>()
						const later: Effect.Effect<void, string> = Deferred.succeed(
							takeoverStarted,
							undefined,
						).pipe(
							Effect.andThen(
								loading ? Effect.never : Effect.fail("Later owner's failure"),
							),
						)
						const grandchild = Plugin.make({
							name: "later-grandchild",
							apply: () => later,
						})
						const takenOver = descendant
							? Graft.plugin(grandchild).pipe(Effect.asVoid)
							: later
						const child = Plugin.make({
							name: "recreated-child",
							apply: () =>
								Effect.gen(function* () {
									const run = yield* Ref.updateAndGet(childRuns, (n) => n + 1)
									if (run === 2) {
										yield* Deferred.succeed(recovering, undefined)
										return yield* Effect.never
									}
									if (run > 2) yield* takenOver
								}),
						})
						const parent = Plugin.make({
							name: "restored-parent",
							apply: (): Effect.Effect<
								void,
								string,
								Graft.Graft | Scope.Scope
							> =>
								Effect.gen(function* () {
									const run = yield* Ref.updateAndGet(parentRuns, (n) => n + 1)
									const fork = yield* Graft.plugin(child)
									if (run > 1) {
										yield* Deferred.succeed(recreated, fork)
										yield* Deferred.await(parentRelease)
									}
								}),
						})
						const broken = Plugin.make({
							name: "broken-parent",
							apply: () => Effect.fail("Parent replacement failed"),
						})
						const root = yield* Graft.plugin(parent)
						yield* root.stable
						const original = yield* Effect.forkScoped(
							Graft.replace([[parent, broken]]),
						)
						const restoredChild = yield* Deferred.await(recreated)
						yield* Deferred.await(recovering)
						const laterPlugin = Plugin.make({
							name: "later-child",
							apply: () => takenOver,
						})
						yield* Effect.forkScoped(
							action === "restart"
								? restoredChild.restart
								: Graft.replace([[child, laterPlugin]]).pipe(Effect.asVoid),
						)
						yield* Deferred.await(takeoverStarted)
						yield* Deferred.succeed(parentRelease, undefined)
						const waiting = yield* Effect.forkScoped(
							Effect.timeoutOption(Fiber.join(original), 1),
						)
						yield* TestClock.adjust(1)
						const outcome = yield* Fiber.join(waiting)
						assert.isTrue(Option.isSome(outcome))
						if (Option.isSome(outcome))
							assert.equal(outcome.value._tag, "RolledBack")
					}).pipe(run),
			)
		}
	}
}
