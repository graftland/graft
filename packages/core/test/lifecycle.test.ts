import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Ref,
	Schedule,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import * as Mount from "../src/Mount.ts"
import { makeJournal, reach, run, type Journal } from "./b1b-utils.ts"

class Database extends Context.Service<Database, { readonly name: string }>()(
	"@graftland/graft/test/lifecycle.test/Database",
) {}
class Cache extends Context.Service<Cache, { readonly name: string }>()(
	"@graftland/graft/test/lifecycle.test/Cache",
) {}
class Greeting extends Context.Service<
	Greeting,
	{ readonly greeting: string }
>()("@graftland/graft/test/lifecycle.test/Greeting") {}

describe("lifecycle", () => {
	it.effect(
		"builds the layer on mount and runs its finalizers on unmount",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.acquireRelease(journal.record("open"), () =>
							journal.record("close"),
						),
					),
					{ name: "resource" },
				)
				yield* mount.await
				yield* mount.unmount
				yield* journal.expect(["open", "close"])
			}).pipe(run),
	)

	it.effect("unloads children before their parent", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const parent = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						yield* Effect.acquireRelease(journal.record("parent open"), () =>
							journal.record("parent close"),
						)
						const child = yield* Graft.mount(
							Layer.effectDiscard(
								Effect.acquireRelease(journal.record("child open"), () =>
									journal.record("child close"),
								),
							),
							{ name: "child" },
						)
						yield* child.await
					}),
				),
				{ name: "parent" },
			)
			yield* parent.await
			yield* parent.unmount
			yield* journal.expect([
				"parent open",
				"child open",
				"child close",
				"parent close",
			])
		}).pipe(run),
	)

	it.effect("restarts with the same layer when asked to", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.acquireRelease(journal.record("start"), () =>
						journal.record("stop"),
					),
				),
				{ name: "restartable" },
			)
			yield* mount.await
			yield* mount.restart
			yield* reach(mount, "Loading")
			yield* reach(mount, "Active")
			yield* journal.expect(["start", "stop", "start"])
		}).pipe(run),
	)

	it.effect(
		"rebuilds dependents with the new value instead of updating in place",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const config = yield* Graft.publish(Greeting, { greeting: "hello" })
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.acquireRelease(
							Effect.flatMap(Greeting, (value) =>
								journal.record(`opened with ${value.greeting}`),
							),
							() => journal.record("closed"),
						),
					),
					{ name: "greeter", requires: [Greeting] },
				)
				yield* mount.await
				yield* config.set({ greeting: "hi" })
				yield* reach(mount, "Loading")
				yield* reach(mount, "Active")
				yield* config.set({ greeting: "restart" })
				yield* reach(mount, "Loading")
				yield* reach(mount, "Active")
				yield* journal.expect([
					"opened with hello",
					"closed",
					"opened with hi",
					"closed",
					"opened with restart",
				])
			}).pipe(run),
	)

	it.effect(
		"cleans up immediately when the layer fails, and leaves siblings alone",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const sibling = yield* Graft.mount(
					Layer.effectDiscard(journal.record("sibling")),
					{ name: "sibling" },
				)
				yield* sibling.await
				const failing = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Effect.acquireRelease(journal.record("acquired"), () =>
								journal.record("released"),
							)
							yield* Graft.publish(Database, { name: "broken" })
							return yield* Effect.fail("boom")
						}),
					),
					{ name: "failing" },
				)
				const error = yield* Effect.flip(failing.await)
				assert.strictEqual(error, "boom")
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(journal.record("consumer")),
					{ name: "consumer", requires: [Database] },
				)
				yield* reach(consumer, "Pending")
				yield* journal.expect(["sibling", "acquired", "released"])
			}).pipe(run),
	)

	it.effect("retries a failed mount on its schedule", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const attempts = yield* Ref.make(0)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
						if (attempt < 3) return yield* Effect.fail(`attempt ${attempt}`)
						yield* journal.record("up")
					}),
				),
				{ name: "flaky", retry: Schedule.spaced("1 second") },
			)
			yield* Effect.raceFirst(
				reach(mount, "Active"),
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
		Graft.mount(
			Layer.effect(
				Database,
				Effect.gen(function* () {
					yield* Effect.acquireRelease(journal.record(`${name} open`), () =>
						journal.record(`${name} close`),
					)
					return { name }
				}),
			),
			{ name: `provider ${name}` },
		)

	const consumer = (journal: Journal) =>
		Graft.mount(
			Layer.effectDiscard(
				Effect.gen(function* () {
					const database = yield* Database
					yield* Effect.acquireRelease(
						journal.record(`use ${database.name}`),
						() => journal.record(`drop ${database.name}`),
					)
				}),
			),
			{ name: "consumer", requires: [Database] },
		)

	it.effect("keeps a consumer pending until its dependency is provided", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const mount = yield* consumer(journal)
			yield* reach(mount, "Pending")
			const state = yield* Stream.runHead(mount.state)
			assert.deepStrictEqual(
				Option.getOrThrow(state),
				Mount.MountState.Pending({ missing: [Database.key] }),
			)
			yield* provider(journal)
			yield* reach(mount, "Active")
			yield* journal.expect(["primary open", "use primary"])
		}).pipe(run),
	)

	it.effect("tears consumers down before the provider releases anything", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const providerMount = yield* provider(journal)
			yield* providerMount.await
			const consumerMount = yield* consumer(journal)
			yield* reach(consumerMount, "Active")
			yield* providerMount.unmount
			yield* reach(consumerMount, "Pending")
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
			const providerMount = yield* provider(journal)
			yield* providerMount.await
			const consumerMount = yield* consumer(journal)
			yield* reach(consumerMount, "Active")
			yield* providerMount.restart
			yield* reach(consumerMount, "Pending")
			yield* reach(consumerMount, "Active")
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
			const providerMount = yield* provider(journal)
			const slow = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						yield* Deferred.succeed(started, undefined)
						return yield* Effect.onInterrupt(Effect.never, () =>
							journal.record("interrupted"),
						)
					}),
				),
				{ name: "slow", requires: [Database] },
			)
			yield* Deferred.await(started)
			yield* providerMount.unmount
			yield* reach(slow, "Pending")
			yield* journal.expect(["primary open", "interrupted", "primary close"])
		}).pipe(run),
	)

	it.effect("restarts when an optional dependency appears or disappears", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const database = yield* Effect.serviceOption(Database)
						yield* journal.record(
							database._tag === "Some"
								? `with ${database.value.name}`
								: "without",
						)
					}),
				),
				{ name: "optional", requires: [Graft.optional(Database)] },
			)
			yield* mount.await
			const providerMount = yield* provider(journal)
			yield* providerMount.await
			yield* reach(mount, "Loading")
			yield* reach(mount, "Active")
			yield* providerMount.unmount
			yield* reach(mount, "Loading")
			yield* reach(mount, "Active")
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
			const first = yield* provider(journal, "first")
			yield* first.await
			const second = yield* provider(journal, "second")
			const exit = yield* Effect.exit(second.await)
			assert.isTrue(Exit.isFailure(exit) && Cause.hasFails(exit.cause))
		}).pipe(run),
	)

	it.effect("gives isolated mounts a private realm", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const group = (label: string) =>
				Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const providerMount = yield* provider(journal, label)
							yield* providerMount.await
							const consumerMount = yield* consumer(journal)
							yield* consumerMount.await
						}),
					),
					{ name: label, isolate: [Database] },
				)
			yield* Effect.flatMap(provider(journal, "root"), (mount) => mount.await)
			yield* Effect.flatMap(group("left"), (mount) => mount.await)
			yield* Effect.flatMap(group("right"), (mount) => mount.await)
			yield* Effect.flatMap(consumer(journal), (mount) => mount.await)
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

	it.effect("shares a labelled realm between mounts", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const shared = [[Database, "shared"]] as const
			yield* Effect.flatMap(
				Graft.mount(
					Layer.effect(
						Database,
						Effect.gen(function* () {
							yield* Effect.acquireRelease(journal.record("shared open"), () =>
								journal.record("shared close"),
							)
							return { name: "shared" }
						}),
					),
					{ name: "provider shared", isolate: shared },
				),
				(mount) => mount.await,
			)
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const database = yield* Database
						yield* Effect.acquireRelease(
							journal.record(`use ${database.name}`),
							() => journal.record(`drop ${database.name}`),
						)
					}),
				),
				{ name: "consumer", requires: [Database], isolate: shared },
			)
			yield* mount.await
			const outside = yield* consumer(journal)
			yield* reach(outside, "Pending")
			yield* journal.expect(["shared open", "use shared"])
		}).pipe(run),
	)
})

describe("layer outputs", () => {
	it.effect("publishes every service the layer outputs", () =>
		Effect.gen(function* () {
			const both = Layer.mergeAll(
				Layer.succeed(Database, { name: "layered" }),
				Layer.succeed(Cache, { name: "layered" }),
			)
			yield* Effect.flatMap(
				Graft.mount(both, { name: "layer" }),
				(mount) => mount.await,
			)
			const usesCache = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
				name: "cache user",
				requires: [Cache],
			})
			yield* usesCache.await
			const usesDatabase = yield* Graft.mount(
				Layer.effectDiscard(Effect.void),
				{ name: "database user", requires: [Database] },
			)
			yield* usesDatabase.await
		}).pipe(run),
	)
})
