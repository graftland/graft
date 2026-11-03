import { assert, describe, it } from "@effect/vitest"
import type { Scope } from "effect"
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Queue,
	Ref,
	Schema,
} from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { makeJournal, reach } from "./utils.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/ambient-lifecycle.test/Service",
) {}

const ambientLayer = Graft.layer.pipe(
	Layer.provideMerge(Layer.succeed(Service, "ambient")),
)
const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(ambientLayer)))

const expectValue = (seen: Queue.Queue<string>, expected: string) =>
	Effect.map(Queue.take(seen), (value) => assert.strictEqual(value, expected))

const provider = Plugin.service(Service, Effect.succeed("dynamic"), {
	name: "provider",
})

describe("ambient dependency lifecycle", () => {
	for (const optional of [false, true]) {
		it.effect(
			`switches ${optional ? "optional" : "required"} dependencies to provisions and back on every publication`,
			() =>
				Effect.gen(function* () {
					const seen = yield* Queue.unbounded<string>()
					const journal = yield* makeJournal
					const consumer = yield* Graft.plugin(
						Plugin.make({
							name: "consumer",
							inject: [optional ? Plugin.optional(Service) : Service],
							apply: () =>
								Effect.gen(function* () {
									const available = yield* Effect.serviceOption(Service)
									const value = Option.getOrThrow(available)
									yield* Effect.acquireRelease(
										journal.record(`start ${value}`),
										() => journal.record(`stop ${value}`),
									)
									yield* Queue.offer(seen, value)
								}),
						}),
					)
					yield* expectValue(seen, "ambient")
					for (const _ of [0, 1]) {
						const published = yield* Graft.plugin(provider)
						yield* published.await
						yield* expectValue(seen, "dynamic")
						yield* published.dispose
						yield* expectValue(seen, "ambient")
					}
					yield* consumer.dispose
					yield* journal.expect([
						"start ambient",
						"stop ambient",
						"start dynamic",
						"stop dynamic",
						"start ambient",
						"stop ambient",
						"start dynamic",
						"stop dynamic",
						"start ambient",
						"stop ambient",
					])
				}).pipe(run),
		)
	}

	it.effect("changes only consumers in the provision's realm", () =>
		Effect.gen(function* () {
			const seenA = yield* Queue.unbounded<string>()
			const seenB = yield* Queue.unbounded<string>()
			const journalB = yield* makeJournal
			const consumer = (
				seen: Queue.Queue<string>,
				record: (value: string) => Effect.Effect<void>,
			) =>
				Plugin.make({
					name: "consumer",
					config: Schema.String,
					inject: [Service],
					apply: () =>
						Effect.gen(function* () {
							const value = yield* Service
							yield* record(`start ${value}`)
							yield* Queue.offer(seen, value)
							return () => record(`update ${value}`).pipe(Effect.as(true))
						}),
				})
			const a = yield* Graft.plugin(
				consumer(seenA, () => Effect.void),
				"initial",
				{ isolate: [[Service, "a"]] },
			)
			const b = yield* Graft.plugin(
				consumer(seenB, journalB.record),
				"initial",
				{ isolate: [[Service, "b"]] },
			)
			yield* expectValue(seenA, "ambient")
			yield* expectValue(seenB, "ambient")
			const published = yield* Graft.plugin(provider, undefined, {
				isolate: [[Service, "a"]],
			})
			yield* published.await
			yield* expectValue(seenA, "dynamic")
			yield* b.update("after publication")
			yield* published.dispose
			yield* expectValue(seenA, "ambient")
			yield* b.update("after withdrawal")
			yield* a.dispose
			yield* b.dispose
			yield* journalB.expect([
				"start ambient",
				"update ambient",
				"update ambient",
			])
		}).pipe(run),
	)

	it.effect(
		"strips inherited provisions while preserving ambient fallback across generations",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const grandchild = Plugin.make({
					name: "grandchild",
					inject: [Service],
					apply: () => Effect.flatMap(Service, journal.record),
				})
				const child = Plugin.make({
					name: "child without inject",
					apply: () =>
						Effect.gen(function* () {
							const inherited = yield* Effect.serviceOption(Service)
							assert.deepStrictEqual(inherited, Option.some("ambient"))
							const sameRealm = yield* Graft.plugin(grandchild)
							yield* sameRealm.await
							const isolated = yield* Graft.plugin(grandchild, undefined, {
								isolate: [Service],
							})
							yield* isolated.await
						}),
				})
				const parent = Plugin.make({
					name: "parent",
					inject: [Service],
					apply: () =>
						Effect.gen(function* () {
							const value = yield* Service
							assert.strictEqual(value, "dynamic")
							const fork = yield* Graft.plugin(child)
							yield* fork.await
						}),
				})
				const published = yield* Graft.plugin(provider)
				yield* published.await
				const fork = yield* Graft.plugin(parent)
				yield* fork.await
				yield* journal.expect(["dynamic", "ambient"])
			}).pipe(run),
	)

	it.effect(
		"interrupts an ambient apply when a provision appears during loading",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const switched = yield* Deferred.make<void>()
				const journal = yield* makeJournal
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "loading consumer",
						inject: [Service],
						apply: () =>
							Effect.gen(function* () {
								const value = yield* Service
								if (value === "ambient")
									return yield* Deferred.succeed(started, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.ensuring(journal.record("ambient interrupted")),
									)
								yield* journal.record("dynamic started")
								yield* Deferred.succeed(switched, undefined)
							}),
					}),
				)
				yield* Deferred.await(started)
				yield* Graft.provide(Service, "dynamic")
				yield* Deferred.await(switched)
				yield* reach(consumer, "Active")
				yield* journal.expect(["ambient interrupted", "dynamic started"])
			}).pipe(run),
	)

	it.effect("restarts a failed ambient consumer when a provision appears", () =>
		Effect.gen(function* () {
			const consumer = yield* Graft.plugin(
				Plugin.make({
					name: "failed consumer",
					inject: [Service],
					apply: () =>
						Effect.flatMap(Service, (value) =>
							value === "ambient"
								? Effect.fail("ambient unavailable")
								: Effect.void,
						),
				}),
			)
			yield* Effect.exit(consumer.await)
			yield* reach(consumer, "Failed")
			yield* Graft.provide(Service, "dynamic")
			yield* reach(consumer, "Active")
		}).pipe(run),
	)
	it.effect(
		"does not repeatedly restart a plugin that publishes its ambient dependency",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0)
				const stopped = yield* Deferred.make<void>()
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "self publisher",
						inject: [Service],
						apply: () =>
							Effect.gen(function* () {
								const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
								// Bound the regression so a restart loop cannot keep the test alive.
								if (attempt === 3) {
									yield* Deferred.succeed(stopped, undefined)
									return yield* Effect.fail("restart loop")
								}
								const value = yield* Service
								yield* Graft.provide(Service, `wrapped ${value}`).pipe(
									Effect.tapError((error) =>
										Effect.gen(function* () {
											assert.strictEqual(error._tag, "ServiceConflict")
											assert.strictEqual(error.reason, "SelfDependency")
											yield* Deferred.succeed(stopped, undefined)
										}),
									),
								)
							}),
					}),
				)
				yield* Deferred.await(stopped)
				yield* reach(fork, "Failed")
				const count = yield* Ref.get(attempts)
				assert.strictEqual(count, 1)
			}).pipe(run),
	)
	it.effect(
		"drains a provision before releasing it and then resumes with ambient fallback",
		() =>
			Effect.gen(function* () {
				const seen = yield* Queue.unbounded<string>()
				const stopping = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const resourceClosed = yield* Ref.make(false)
				const journal = yield* makeJournal
				const published = yield* Graft.plugin(
					Plugin.service(
						Service,
						Effect.acquireRelease(Effect.succeed("dynamic"), () =>
							Ref.set(resourceClosed, true).pipe(
								Effect.andThen(journal.record("provider closed")),
							),
						),
						{ name: "scoped provider" },
					),
				)
				yield* published.await
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "draining consumer",
						inject: [Service],
						apply: () =>
							Effect.gen(function* () {
								const value = yield* Service
								if (value === "dynamic")
									yield* Effect.addFinalizer(() =>
										Deferred.succeed(stopping, undefined).pipe(
											Effect.andThen(Deferred.await(release)),
											Effect.andThen(journal.record("consumer released")),
										),
									)
								yield* Queue.offer(seen, value)
							}),
					}),
				)
				yield* expectValue(seen, "dynamic")
				const disposing = yield* Effect.forkScoped(published.dispose)
				yield* Deferred.await(stopping)
				const closedEarly = yield* Ref.get(resourceClosed)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(disposing)
				yield* expectValue(seen, "ambient")
				yield* consumer.dispose
				assert.isFalse(closedEarly)
				yield* journal.expect(["consumer released", "provider closed"])
			}).pipe(run),
	)

	it.effect(
		"interrupts an ambient in-place update when a provision appears",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const switched = yield* Deferred.make<void>()
				const journal = yield* makeJournal
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "updating consumer",
						config: Schema.String,
						inject: [Service],
						apply: (config) =>
							Effect.gen(function* () {
								const value = yield* Service
								if (value === "dynamic") {
									yield* journal.record(`dynamic ${config}`)
									yield* Deferred.succeed(switched, undefined)
								}
								return () =>
									Deferred.succeed(started, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.ensuring(journal.record("update interrupted")),
									)
							}),
					}),
					"initial",
				)
				yield* consumer.await
				const updating = yield* Effect.forkScoped(consumer.update("latest"))
				yield* Deferred.await(started)
				yield* Graft.provide(Service, "dynamic")
				yield* Deferred.await(switched)
				yield* Fiber.join(updating)
				yield* journal.expect(["update interrupted", "dynamic latest"])
			}).pipe(run),
	)
})
