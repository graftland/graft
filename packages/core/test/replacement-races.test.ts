import {
	Array,
	Context,
	Deferred,
	Effect,
	Fiber,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
	type Scope,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "../src/index.ts"
import { makeJournal, reach, run } from "./utils.ts"

const quiet = (name: string) =>
	Plugin.make({
		name,
		apply: (): Effect.Effect<void, string> => Effect.void,
	})
const names = Graft.forks.pipe(
	Stream.runHead,
	Effect.map((tree) => Array.map(Option.getOrThrow(tree), (fork) => fork.name)),
)

class Store extends Context.Service<Store, number>()(
	"@graftland/graft/test/replacement-races.test/Store",
) {}

describe("replacement races and edge cases", () => {
	it.effect(
		"restores each fork's own original after a many-to-one replacement",
		() =>
			Effect.gen(function* () {
				const a = quiet("a")
				const b = quiet("b")
				const c = Plugin.make({ name: "c", apply: () => Effect.fail("broken") })
				const first = yield* Graft.plugin(a)
				const second = yield* Graft.plugin(b)
				yield* first.await
				yield* second.await
				const result = yield* Graft.replace([
					[a, c],
					[b, c],
				])
				assert.strictEqual(result._tag, "RolledBack")
				const actual = yield* names
				assert.deepStrictEqual(actual, ["a", "b"])
			}).pipe(run),
	)

	it.effect(
		"restores untouched aliases when a later replacement takes over another pair",
		() =>
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>()
				const entered = yield* Deferred.make<void>()
				const a1 = quiet("a1")
				const a2 = quiet("a2")
				const a3 = quiet("a3")
				const b1 = quiet("b1")
				const b2 = Plugin.make({
					name: "b2",
					apply: () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(entered, undefined)
							yield* Deferred.await(gate)
							return yield* Effect.fail("broken")
						}),
				})
				const a = yield* Graft.plugin(a1)
				const b = yield* Graft.plugin(b1)
				yield* a.await
				yield* b.await
				const first = yield* Graft.replace([
					[a1, a2],
					[b1, b2],
				]).pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				assert.strictEqual((yield* Graft.replace([[a2, a3]]))._tag, "Replaced")
				yield* Deferred.succeed(gate, undefined)
				assert.strictEqual((yield* Fiber.join(first))._tag, "RolledBack")
				const restored = yield* names
				assert.deepStrictEqual(restored, ["a3", "b1"])
				const later = yield* Graft.plugin(b1)
				yield* Effect.exit(later.await)
				const loaded = yield* names
				assert.deepStrictEqual(loaded, ["a3", "b1", "b1"])
			}).pipe(run),
	)

	it.effect(
		"does not report rollback until replacement cleanup and old startup finish",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const closing = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const v1 = quiet("v1")
				const v2 = Plugin.make({
					name: "v2",
					apply: () =>
						Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
							Deferred.succeed(closing, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
							),
						).pipe(Effect.andThen(Effect.never)),
				})
				const fork = yield* Graft.plugin(v1)
				yield* fork.await
				const replacing = yield* Graft.replace([[v1, v2]], {
					timeout: "1 second",
				}).pipe(Effect.forkScoped)
				yield* Deferred.await(started)
				yield* TestClock.adjust("1 second")
				yield* Deferred.await(closing)
				yield* TestClock.adjust("1 second")
				const beforeRelease = yield* Effect.sync(() => replacing.pollUnsafe())
				const runningBeforeRelease = yield* names
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(replacing)
				yield* reach(fork, "Active")
				assert.deepStrictEqual(runningBeforeRelease, ["v2"])
				assert.isUndefined(
					beforeRelease,
					"replace must still wait while v2 owns resources",
				)
			}).pipe(run),
	)

	it.effect(
		"ignores a pre-existing failed fork already running the replacement target",
		() =>
			Effect.gen(function* () {
				const a = quiet("a")
				const b = Plugin.make({
					name: "b",
					apply: () => Effect.fail("pre-existing failure"),
				})
				const existing = yield* Graft.plugin(b)
				yield* Effect.exit(existing.await)
				const result = yield* Graft.replace([[a, b]])
				assert.strictEqual(result._tag, "Replaced")
			}).pipe(run),
	)

	it.effect(
		"uses the first failure even when the retry schedule has no delay",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0)
				const v1 = quiet("v1")
				const v2 = Plugin.make({
					name: "v2",
					retry: Schedule.recurs(1),
					apply: () =>
						Ref.updateAndGet(attempts, (n) => n + 1).pipe(
							Effect.flatMap((n) =>
								n === 1 ? Effect.fail("first failure") : Effect.void,
							),
						),
				})
				const fork = yield* Graft.plugin(v1)
				yield* fork.await
				assert.strictEqual(
					(yield* Graft.replace([[v1, v2]]))._tag,
					"RolledBack",
				)
			}).pipe(run),
	)
	it.effect(
		"observes a sibling failure while another replacement remains loading",
		() =>
			Effect.gen(function* () {
				const a1 = quiet("a1")
				const a2 = Plugin.make({ name: "a2", apply: () => Effect.never })
				const b1 = quiet("b1")
				const b2 = Plugin.make({
					name: "b2",
					apply: () => Effect.fail("broken"),
				})
				const a = yield* Graft.plugin(a1)
				const b = yield* Graft.plugin(b1)
				yield* a.await
				yield* b.await
				const result = yield* Graft.replace([
					[a1, a2],
					[b1, b2],
				])
				assert.strictEqual(result._tag, "RolledBack")
			}).pipe(run),
	)

	it.effect("does not roll back because a dependent fails", () =>
		Effect.gen(function* () {
			const provider = (value: number) =>
				Plugin.make({
					name: `store-${value}`,
					apply: () => Graft.provide(Store, value),
				})
			const v1 = provider(1)
			const v2 = provider(2)
			const consumer = Plugin.make({
				name: "consumer",
				inject: [Store],
				apply: () =>
					Store.pipe(
						Effect.flatMap((value) =>
							value === 2 ? Effect.fail("consumer failure") : Effect.void,
						),
					),
			})
			const store = yield* Graft.plugin(v1)
			const dependent = yield* Graft.plugin(consumer)
			yield* store.await
			yield* dependent.await
			const result = yield* Graft.replace([[v1, v2]])
			yield* reach(dependent, "Failed")
			assert.strictEqual(result._tag, "Replaced")
		}).pipe(run),
	)

	it.effect(
		"runs the dependent against both the new and restored service",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const consumingNew = yield* Deferred.make<void>()
				const fail = yield* Deferred.make<void>()
				const provider = (value: number) =>
					Plugin.make({
						name: `store-${value}`,
						apply: () => Graft.provide(Store, value),
					})
				const v1 = provider(1)
				const v2 = provider(2)
				const b1 = quiet("b1")
				const b2 = Plugin.make({
					name: "b2",
					apply: () =>
						Deferred.await(fail).pipe(Effect.andThen(Effect.fail("broken"))),
				})
				const consumer = Plugin.make({
					name: "consumer",
					inject: [Store],
					apply: () =>
						Effect.gen(function* () {
							const value = yield* Store
							yield* Effect.acquireRelease(
								journal.record(`uses ${value}`),
								() => journal.record(`drops ${value}`),
							)
							if (value === 2) yield* Deferred.succeed(consumingNew, undefined)
						}),
				})
				const store = yield* Graft.plugin(v1)
				const dependent = yield* Graft.plugin(consumer)
				const blocker = yield* Graft.plugin(b1)
				yield* store.await
				yield* dependent.await
				yield* blocker.await
				const replacing = yield* Graft.replace([
					[v1, v2],
					[b1, b2],
				]).pipe(Effect.forkScoped)
				yield* Deferred.await(consumingNew)
				yield* Deferred.succeed(fail, undefined)
				const result = yield* Fiber.join(replacing)
				assert.strictEqual(result._tag, "RolledBack")
				yield* reach(dependent, "Active")
				yield* journal.expect([
					"uses 1",
					"drops 1",
					"uses 2",
					"drops 2",
					"uses 1",
				])
			}).pipe(run),
	)
})

describe("replacement judgement scope", () => {
	it.effect(
		"leaves forks already on an unchanged target alone on rollback",
		() =>
			Effect.gen(function* () {
				const p = quiet("p")
				const q = quiet("q")
				const a1 = quiet("a1")
				const a2 = Plugin.make({
					name: "a2",
					apply: () => Effect.fail("broken"),
				})
				for (const plugin of [p, q, a1]) {
					const fork = yield* Graft.plugin(plugin)
					yield* fork.await
				}
				const result = yield* Graft.replace([
					[p, q],
					[a1, a2],
				])
				assert.strictEqual(result._tag, "RolledBack")
				const after = yield* names
				assert.deepStrictEqual(after, ["p", "q", "a1"])
			}).pipe(run),
	)

	it.effect("judges a new child that a replaced parent loads", () =>
		Effect.gen(function* () {
			const parent1 = quiet("parent1")
			const child = Plugin.make({
				name: "child",
				apply: () => Effect.fail("broken child"),
			})
			const parent2 = Plugin.make({
				name: "parent2",
				apply: (): Effect.Effect<void, string, Graft.Graft | Scope.Scope> =>
					Effect.asVoid(Graft.plugin(child)),
			})
			const fork = yield* Graft.plugin(parent1)
			yield* fork.await
			const result = yield* Graft.replace([[parent1, parent2]])
			assert.strictEqual(result._tag, "RolledBack")
			const after = yield* names
			assert.deepStrictEqual(after, ["parent1"])
		}).pipe(run),
	)
})

describe("forks that ask for a target directly", () => {
	it.effect("neither decide the replacement nor move on rollback", () =>
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>()
			const Input = Schema.Struct({ fail: Schema.Boolean })
			const p = Plugin.make({
				name: "p",
				config: Input,
				apply: (): Effect.Effect<void, string> => Effect.void,
			})
			// Fails only where its input says so: the fork loaded with q directly.
			const q = Plugin.make({
				name: "q",
				config: Input,
				apply: ({ fail }): Effect.Effect<void, string> =>
					fail ? Effect.fail("direct failure") : Effect.void,
			})
			const b1 = quiet("b1")
			const b2 = Plugin.make({
				name: "b2",
				apply: () =>
					Effect.andThen(Deferred.await(release), Effect.fail("broken")),
			})
			const moved = yield* Graft.plugin(p, { fail: false })
			yield* moved.await
			const other = yield* Graft.plugin(b1)
			yield* other.await
			const replacing = yield* Graft.replace([
				[p, q],
				[b1, b2],
			]).pipe(Effect.forkScoped)
			const direct = yield* Graft.plugin(q, { fail: true })
			yield* Effect.exit(direct.await)
			yield* Deferred.succeed(release, undefined)
			const result = yield* Fiber.join(replacing)
			assert.strictEqual(result._tag, "RolledBack")
			if (result._tag === "RolledBack")
				assert.deepStrictEqual(
					Array.map(result.failures, (failure) => failure.plugin),
					["b2"],
				)
			const resolved = yield* Graft.resolve(p)
			assert.strictEqual(resolved, p)
			const after = yield* names
			assert.deepStrictEqual(after, ["p", "b1", "q"])
		}).pipe(run),
	)
})

describe("forks a later replacement took over", () => {
	it.effect(
		"do not decide the earlier replacement, nor do their children",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const gate = yield* Deferred.make<void>()
				const child = Plugin.make({
					name: "child",
					apply: (): Effect.Effect<void, string> => Effect.fail("child broken"),
				})
				const v1 = quiet("v1")
				const v2 = quiet("v2")
				const v3 = Plugin.make({
					name: "v3",
					apply: (): Effect.Effect<void, string, Graft.Graft | Scope.Scope> =>
						Effect.asVoid(Graft.plugin(child)),
				})
				const b1 = quiet("b1")
				const b2 = Plugin.make({
					name: "b2",
					apply: (): Effect.Effect<void, string> =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(gate)),
						),
				})
				const moved = yield* Graft.plugin(v1)
				yield* moved.await
				const other = yield* Graft.plugin(b1)
				yield* other.await
				const first = yield* Graft.replace([
					[v1, v2],
					[b1, b2],
				]).pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				// Takes the v1 fork over; v3's child fails, so this one rolls back to v2.
				const second = yield* Graft.replace([[v2, v3]])
				assert.strictEqual(second._tag, "RolledBack")
				yield* Deferred.succeed(gate, undefined)
				const result = yield* Fiber.join(first)
				assert.strictEqual(result._tag, "Replaced")
				yield* moved.stable
				const after = yield* names
				assert.deepStrictEqual(after, ["v2", "b2"])
			}).pipe(run),
	)
})
