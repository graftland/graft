import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Fiber,
	Option,
	Schedule,
	Stream,
} from "effect"
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
