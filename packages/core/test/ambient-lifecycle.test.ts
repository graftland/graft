import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Queue,
	Ref,
	type Scope,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "../src/index.ts"
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

const provider = Layer.effect(Service, Effect.succeed("dynamic"))

describe("ambient dependency lifecycle", () => {
	for (const optional of [false, true]) {
		it.effect(
			`switches ${optional ? "optional" : "required"} dependencies to provisions and back on every publication`,
			() =>
				Effect.gen(function* () {
					const seen = yield* Queue.unbounded<string>()
					const journal = yield* makeJournal
					const consumer = yield* Graft.mount(
						Layer.effectDiscard(
							Effect.gen(function* () {
								const available = yield* Effect.serviceOption(Service)
								const value = Option.getOrThrow(available)
								yield* Effect.acquireRelease(
									journal.record(`start ${value}`),
									() => journal.record(`stop ${value}`),
								)
								yield* Queue.offer(seen, value)
							}),
						),
						{
							name: "consumer",
							requires: [optional ? Graft.optional(Service) : Service],
						},
					)
					yield* expectValue(seen, "ambient")
					for (const _ of [0, 1]) {
						const published = yield* Graft.mount(provider, { name: "provider" })
						yield* published.await
						yield* expectValue(seen, "dynamic")
						yield* published.unmount
						yield* expectValue(seen, "ambient")
					}
					yield* consumer.unmount
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
				Layer.effectDiscard(
					Effect.gen(function* () {
						const value = yield* Service
						yield* record(`start ${value}`)
						yield* Queue.offer(seen, value)
					}),
				)
			const a = yield* Graft.mount(
				consumer(seenA, () => Effect.void),
				{
					name: "consumer",
					requires: [Service],
					isolate: [[Service, "a"]],
				},
			)
			const b = yield* Graft.mount(consumer(seenB, journalB.record), {
				name: "consumer",
				requires: [Service],
				isolate: [[Service, "b"]],
			})
			yield* expectValue(seenA, "ambient")
			yield* expectValue(seenB, "ambient")
			const published = yield* Graft.mount(provider, {
				name: "provider",
				isolate: [[Service, "a"]],
			})
			yield* published.await
			yield* expectValue(seenA, "dynamic")
			yield* b.restart
			yield* b.await
			yield* published.unmount
			yield* expectValue(seenA, "ambient")
			yield* b.restart
			yield* b.await
			yield* a.unmount
			yield* b.unmount
			yield* journalB.expect([
				"start ambient",
				"start ambient",
				"start ambient",
			])
		}).pipe(run),
	)

	it.effect(
		"strips inherited provisions while preserving ambient fallback across generations",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const grandchild = Layer.effectDiscard(
					Effect.flatMap(Service, journal.record),
				)
				const child = Layer.effectDiscard(
					Effect.gen(function* () {
						const inherited = yield* Effect.serviceOption(Service)
						assert.deepStrictEqual(inherited, Option.some("ambient"))
						const sameRealm = yield* Graft.mount(grandchild, {
							name: "grandchild",
							requires: [Service],
						})
						yield* sameRealm.await
						const isolated = yield* Graft.mount(grandchild, {
							name: "grandchild",
							requires: [Service],
							isolate: [Service],
						})
						yield* isolated.await
					}),
				)
				const parent = Layer.effectDiscard(
					Effect.gen(function* () {
						const value = yield* Service
						assert.strictEqual(value, "dynamic")
						const mount = yield* Graft.mount(child, {
							name: "child without requires",
						})
						yield* mount.await
					}),
				)
				const published = yield* Graft.mount(provider, { name: "provider" })
				yield* published.await
				const mount = yield* Graft.mount(parent, {
					name: "parent",
					requires: [Service],
				})
				yield* mount.await
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
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
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
					),
					{ name: "loading consumer", requires: [Service] },
				)
				yield* Deferred.await(started)
				const publication = yield* Graft.publish(Service, "dynamic")
				yield* publication.await
				yield* Deferred.await(switched)
				yield* reach(consumer, "Active")
				yield* journal.expect(["ambient interrupted", "dynamic started"])
			}).pipe(run),
	)

	it.effect("restarts a failed ambient consumer when a provision appears", () =>
		Effect.gen(function* () {
			const consumer = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.flatMap(Service, (value) =>
						value === "ambient"
							? Effect.fail("ambient unavailable")
							: Effect.void,
					),
				),
				{ name: "failed consumer", requires: [Service] },
			)
			yield* Effect.exit(consumer.await)
			yield* reach(consumer, "Failed")
			const publication = yield* Graft.publish(Service, "dynamic")
			yield* publication.await
			yield* reach(consumer, "Active")
		}).pipe(run),
	)
	it.effect(
		"does not repeatedly restart a mount that publishes its ambient dependency",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0)
				const stopped = yield* Deferred.make<void>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
							// Bound the regression so a restart loop cannot keep the test alive.
							if (attempt === 3) {
								yield* Deferred.succeed(stopped, undefined)
								return yield* Effect.fail("restart loop")
							}
							const value = yield* Service
							const publication = yield* Graft.publish(
								Service,
								`wrapped ${value}`,
							)
							yield* publication.await.pipe(
								Effect.tapError((error) =>
									Effect.gen(function* () {
										assert.strictEqual(error._tag, "ServiceConflict")
										assert.strictEqual(error.reason, "DependencyCycle")
										yield* Deferred.succeed(stopped, undefined)
									}),
								),
							)
						}),
					),
					{ name: "self publisher", requires: [Service] },
				)
				yield* Deferred.await(stopped)
				yield* reach(mount, "Failed")
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
				const published = yield* Graft.mount(
					Layer.effect(
						Service,
						Effect.acquireRelease(Effect.succeed("dynamic"), () =>
							Ref.set(resourceClosed, true).pipe(
								Effect.andThen(journal.record("provider closed")),
							),
						),
					),
					{ name: "scoped provider" },
				)
				yield* published.await
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
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
					),
					{ name: "draining consumer", requires: [Service] },
				)
				yield* expectValue(seen, "dynamic")
				const disposing = yield* Effect.forkScoped(published.unmount)
				yield* Deferred.await(stopping)
				const closedEarly = yield* Ref.get(resourceClosed)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(disposing)
				yield* expectValue(seen, "ambient")
				yield* consumer.unmount
				assert.isFalse(closedEarly)
				yield* journal.expect(["consumer released", "provider closed"])
			}).pipe(run),
	)
})
