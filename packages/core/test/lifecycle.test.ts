import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Fork, Graft, Plugin } from "../src/index.ts"
import { makeJournal, reach, run, type Journal } from "./utils.ts"

class Database extends Context.Service<Database, { readonly name: string }>()(
	"@graftland/graft/test/lifecycle.test/Database",
) {}
class Cache extends Context.Service<Cache, { readonly name: string }>()(
	"@graftland/graft/test/lifecycle.test/Cache",
) {}

describe("lifecycle", () => {
	it.effect("runs apply on load and its finalizers on dispose", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const plugin = Plugin.make({
				name: "resource",
				apply: () =>
					Effect.acquireRelease(journal.record("open"), () =>
						journal.record("close"),
					),
			})
			const fork = yield* Graft.plugin(plugin)
			yield* fork.await
			yield* fork.dispose
			yield* journal.expect(["open", "close"])
		}).pipe(run),
	)

	it.effect("unloads children before their parent", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const child = Plugin.make({
				name: "child",
				apply: () =>
					Effect.acquireRelease(journal.record("child open"), () =>
						journal.record("child close"),
					),
			})
			const parent = Plugin.make({
				name: "parent",
				apply: () =>
					Effect.gen(function* () {
						yield* Effect.acquireRelease(journal.record("parent open"), () =>
							journal.record("parent close"),
						)
						const fork = yield* Graft.plugin(child)
						yield* fork.await
					}),
			})
			const fork = yield* Graft.plugin(parent)
			yield* fork.await
			yield* fork.dispose
			yield* journal.expect([
				"parent open",
				"child open",
				"child close",
				"parent close",
			])
		}).pipe(run),
	)

	it.effect(
		"fails with the schema error and never runs apply on invalid config",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const plugin = Plugin.make({
					name: "server",
					config: Schema.Struct({ port: Schema.Finite }),
					apply: ({ port }) => journal.record(`listen ${port}`),
				})
				const fork = yield* Graft.plugin(plugin, {
					// @ts-expect-error A string port must fail the typed input; the runtime decoder is checked below.
					port: "80",
				})
				const exit = yield* Effect.exit(fork.await)
				assert.isTrue(Exit.isFailure(exit))
				yield* journal.expect([])
			}).pipe(run),
	)

	it.effect("restarts with the same config when asked to", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const plugin = Plugin.make({
				name: "restartable",
				apply: () =>
					Effect.acquireRelease(journal.record("start"), () =>
						journal.record("stop"),
					),
			})
			const fork = yield* Graft.plugin(plugin)
			yield* fork.await
			yield* fork.restart
			yield* reach(fork, "Loading")
			yield* reach(fork, "Active")
			yield* journal.expect(["start", "stop", "start"])
		}).pipe(run),
	)

	it.effect("updates in place through the function apply returns", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const updated = yield* Deferred.make<void>()
			const plugin = Plugin.make({
				name: "greeter",
				config: Schema.Struct({ greeting: Schema.String }),
				apply: ({ greeting }) =>
					Effect.gen(function* () {
						const opened = `opened with ${greeting}`
						yield* journal.record(opened)
						return (next: { readonly greeting: string }) =>
							journal
								.record(`${opened}, now ${next.greeting}`)
								.pipe(
									Effect.andThen(Deferred.succeed(updated, undefined)),
									Effect.as(next.greeting !== "restart"),
								)
					}),
			})
			const fork = yield* Graft.plugin(plugin, { greeting: "hello" })
			yield* fork.await
			yield* fork.update({ greeting: "hi" })
			yield* Deferred.await(updated)
			yield* fork.update({ greeting: "restart" })
			yield* reach(fork, "Loading")
			yield* reach(fork, "Active")
			yield* journal.expect([
				"opened with hello",
				"opened with hello, now hi",
				"opened with hello, now restart",
				"opened with restart",
			])
		}).pipe(run),
	)

	it.effect(
		"cleans up immediately when apply fails, and leaves siblings alone",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const failing = Plugin.make({
					name: "failing",
					apply: () =>
						Effect.gen(function* () {
							yield* Effect.acquireRelease(journal.record("acquired"), () =>
								journal.record("released"),
							)
							yield* Graft.provide(Database, { name: "broken" })
							return yield* Effect.fail("boom")
						}),
				})
				const sibling = Plugin.make({
					name: "sibling",
					apply: () => journal.record("sibling"),
				})
				const healthy = yield* Graft.plugin(sibling)
				const fork = yield* Graft.plugin(failing)
				const error = yield* Effect.flip(fork.await)
				assert.strictEqual(error, "boom")
				yield* healthy.await
				const consumer = Plugin.make({
					name: "consumer",
					inject: [Database],
					apply: () => journal.record("consumer"),
				})
				const consumerFork = yield* Graft.plugin(consumer)
				yield* reach(consumerFork, "Pending")
				yield* journal.expect(["sibling", "acquired", "released"])
			}).pipe(run),
	)

	it.effect("retries a failed plugin on its schedule", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const attempts = yield* Ref.make(0)
			const flaky = Plugin.make({
				name: "flaky",
				retry: Schedule.spaced("1 second"),
				apply: () =>
					Effect.gen(function* () {
						const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
						if (attempt < 3) return yield* Effect.fail(`attempt ${attempt}`)
						yield* journal.record("up")
					}),
			})
			const fork = yield* Graft.plugin(flaky)
			yield* Effect.raceFirst(
				reach(fork, "Active"),
				Effect.forever(TestClock.adjust("1 second")),
			)
			const attempted = yield* Ref.get(attempts)
			assert.strictEqual(attempted, 3)
			yield* journal.expect(["up"])
		}).pipe(run),
	)
})

describe("services", () => {
	const provider = (journal: Journal, name = "primary") =>
		Plugin.make({
			name: `provider ${name}`,
			apply: () =>
				Effect.gen(function* () {
					yield* Graft.provide(Database, { name })
					// Acquired after publishing: it must still outlive every consumer.
					yield* Effect.acquireRelease(journal.record(`${name} open`), () =>
						journal.record(`${name} close`),
					)
				}),
		})

	const consumer = (journal: Journal) =>
		Plugin.make({
			name: "consumer",
			inject: [Database],
			apply: () =>
				Effect.gen(function* () {
					const database = yield* Database
					yield* Effect.acquireRelease(
						journal.record(`use ${database.name}`),
						() => journal.record(`drop ${database.name}`),
					)
				}),
		})

	it.effect("keeps a consumer pending until its dependency is provided", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const fork = yield* Graft.plugin(consumer(journal))
			yield* reach(fork, "Pending")
			const state = yield* Stream.runHead(fork.state)
			assert.deepStrictEqual(
				state._tag === "Some" && state.value,
				Fork.ForkState.Pending({
					missing: ["@graftland/graft/test/lifecycle.test/Database"],
				}),
			)
			yield* Graft.plugin(provider(journal))
			yield* reach(fork, "Active")
			yield* journal.expect(["primary open", "use primary"])
		}).pipe(run),
	)

	it.effect("tears consumers down before the provider releases anything", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const providerFork = yield* Graft.plugin(provider(journal))
			yield* providerFork.await
			const consumerFork = yield* Graft.plugin(consumer(journal))
			yield* reach(consumerFork, "Active")
			yield* providerFork.dispose
			yield* reach(consumerFork, "Pending")
			yield* journal.expect([
				"primary open",
				"use primary",
				"drop primary",
				"primary close",
			])
		}).pipe(run),
	)

	it.effect("restarts consumers when the provider restarts", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const providerFork = yield* Graft.plugin(provider(journal))
			yield* providerFork.await
			const consumerFork = yield* Graft.plugin(consumer(journal))
			yield* reach(consumerFork, "Active")
			yield* providerFork.restart
			yield* reach(consumerFork, "Pending")
			yield* reach(consumerFork, "Active")
			yield* journal.expect([
				"primary open",
				"use primary",
				"drop primary",
				"primary close",
				"primary open",
				"use primary",
			])
		}).pipe(run),
	)

	it.effect("interrupts initialization when a dependency goes away", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const started = yield* Deferred.make<void>()
			const slow = Plugin.make({
				name: "slow",
				inject: [Database],
				apply: () =>
					Effect.gen(function* () {
						yield* Deferred.succeed(started, undefined)
						return yield* Effect.onInterrupt(Effect.never, () =>
							journal.record("interrupted"),
						)
					}),
			})
			const providerFork = yield* Graft.plugin(provider(journal))
			const slowFork = yield* Graft.plugin(slow)
			yield* Deferred.await(started)
			yield* providerFork.dispose
			yield* reach(slowFork, "Pending")
			yield* journal.expect(["primary open", "interrupted", "primary close"])
		}).pipe(run),
	)

	it.effect("restarts when an optional dependency appears or disappears", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const plugin = Plugin.make({
				name: "optional",
				inject: [Plugin.optional(Database)],
				apply: () =>
					Effect.gen(function* () {
						const database = yield* Effect.serviceOption(Database)
						yield* journal.record(
							database._tag === "Some"
								? `with ${database.value.name}`
								: "without",
						)
					}),
			})
			const fork = yield* Graft.plugin(plugin)
			yield* fork.await
			const providerFork = yield* Graft.plugin(provider(journal))
			yield* providerFork.await
			yield* reach(fork, "Loading")
			yield* reach(fork, "Active")
			yield* providerFork.dispose
			yield* reach(fork, "Loading")
			yield* reach(fork, "Active")
			yield* journal.expect([
				"without",
				"primary open",
				"with primary",
				"primary close",
				"without",
			])
		}).pipe(run),
	)

	it.effect("rejects a second provider in the same realm", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			yield* Effect.flatMap(
				Graft.plugin(provider(journal, "first")),
				(fork) => fork.await,
			)
			const exit = yield* Effect.exit(
				Effect.flatMap(
					Graft.plugin(provider(journal, "second")),
					(fork) => fork.await,
				),
			)
			assert.isTrue(Exit.isFailure(exit) && Cause.hasFails(exit.cause))
		}).pipe(run),
	)

	it.effect("gives isolated forks a private realm", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const group = (label: string) =>
				Plugin.make({
					name: label,
					apply: () =>
						Effect.gen(function* () {
							yield* Effect.flatMap(
								Graft.plugin(provider(journal, label)),
								(fork) => fork.await,
							)
							yield* Effect.flatMap(
								Graft.plugin(consumer(journal)),
								(fork) => fork.await,
							)
						}),
				})
			yield* Effect.flatMap(
				Graft.plugin(provider(journal, "root")),
				(fork) => fork.await,
			)
			yield* Effect.flatMap(
				Graft.plugin(group("left"), undefined, {
					isolate: [Database],
				}),
				(fork) => fork.await,
			)
			yield* Effect.flatMap(
				Graft.plugin(group("right"), undefined, {
					isolate: [Database],
				}),
				(fork) => fork.await,
			)
			yield* Effect.flatMap(
				Graft.plugin(consumer(journal)),
				(fork) => fork.await,
			)
			yield* journal.expect([
				"root open",
				"left open",
				"use left",
				"right open",
				"use right",
				"use root",
			])
		}).pipe(run),
	)

	it.effect("shares a labelled realm between forks", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const shared = [[Database, "shared"]] as const
			yield* Effect.flatMap(
				Graft.plugin(provider(journal, "shared"), undefined, {
					isolate: shared,
				}),
				(fork) => fork.await,
			)
			const fork = yield* Graft.plugin(consumer(journal), undefined, {
				isolate: shared,
			})
			yield* fork.await
			const outside = yield* Graft.plugin(consumer(journal))
			yield* reach(outside, "Pending")
			yield* journal.expect(["shared open", "use shared"])
		}).pipe(run),
	)

	it.effect("publishes only the declared outputs of a layer", () =>
		Effect.gen(function* () {
			const both = Layer.mergeAll(
				Layer.succeed(Database, { name: "layered" }),
				Layer.succeed(Cache, { name: "layered" }),
			)
			const plugin = Plugin.layer(both, { name: "layer", provides: [Database] })
			yield* Effect.flatMap(Graft.plugin(plugin), (fork) => fork.await)
			const usesCache = yield* Graft.plugin(
				Plugin.make({
					name: "cache user",
					inject: [Cache],
					apply: () => Effect.void,
				}),
			)
			yield* reach(usesCache, "Pending")
			const usesDatabase = yield* Graft.plugin(
				Plugin.make({
					name: "database user",
					inject: [Database],
					apply: () => Effect.void,
				}),
			)
			yield* usesDatabase.await
		}).pipe(run),
	)
})
