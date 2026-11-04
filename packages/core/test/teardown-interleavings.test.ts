import { registrySnapshot } from "./utils.ts"
import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Option,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { makeJournal, reach, run } from "./utils.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/teardown-interleavings.test/Service",
) {}

describe("teardown interleavings", () => {
	it.effect(
		"withdraws root publications and drains consumers when the runtime layer closes",
		() =>
			Effect.gen(function* () {
				const owner = yield* Effect.scope
				const rootScope = yield* Scope.fork(owner)
				const context = yield* Layer.buildWithScope(
					Layer.fresh(Graft.layer),
					rootScope,
				)
				const { runtime } = Context.get(context, Graft.Graft)
				const released = yield* Ref.make(false)
				yield* Graft.provide(Service, "root").pipe(
					Effect.provideContext(context),
				)
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "root consumer",
						inject: [Service],
						apply: () => Effect.addFinalizer(() => Ref.set(released, true)),
					}),
				).pipe(Effect.provideContext(context))
				yield* consumer.await
				yield* Scope.close(rootScope, Exit.void)
				yield* reach(consumer, "Pending")
				const cleaned = yield* Ref.get(released)
				const registry = yield* registrySnapshot(runtime)
				assert.isTrue(cleaned)
				assert.strictEqual(HashMap.size(registry), 0)
				yield* consumer.dispose
			}).pipe(Effect.scoped),
	)

	it.effect(
		"drains a child consuming its parent's service before releasing the parent",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* Graft.Graft
				const journal = yield* makeJournal
				const closing = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const child = Plugin.make({
					name: "child consumer",
					inject: [Service],
					apply: () =>
						Effect.addFinalizer(() =>
							Deferred.succeed(closing, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(journal.record("child released")),
							),
						),
				})
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "parent provider",
						apply: () =>
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() =>
									journal.record("parent released"),
								)
								yield* Graft.provide(Service, "parent")
								const fork = yield* Graft.plugin(child)
								yield* fork.await
							}),
					}),
				)
				yield* parent.await
				const disposing = yield* Effect.forkScoped(parent.dispose)
				yield* Deferred.await(closing)
				yield* journal.expect([])
				const registry = yield* registrySnapshot(runtime)
				assert.isFalse(HashMap.has(registry, realmKey("", Service.key)))
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(disposing)
				yield* journal.expect(["child released", "parent released"])
				const tree = yield* Stream.runHead(Graft.forks)
				assert.deepStrictEqual(Option.getOrThrow(tree), [])
			}).pipe(run),
	)

	it.effect(
		"settles update callers and terminates state streams after disposal interrupts an update",
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const closing = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const stopped = yield* Ref.make(false)
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "disposed update",
						config: Schema.String,
						apply: () =>
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() =>
									Deferred.succeed(closing, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
									),
								)
								return () =>
									Deferred.succeed(entered, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.ensuring(Ref.set(stopped, true)),
									)
							}),
					}),
					"initial",
				)
				yield* fork.await
				const states = yield* Effect.forkScoped(Stream.runCollect(fork.state))
				const updating = yield* Effect.forkScoped(fork.update("next"))
				yield* Deferred.await(entered)
				const disposing = yield* Effect.forkScoped(fork.dispose)
				yield* Deferred.await(closing)
				const interrupted = yield* Ref.get(stopped)
				assert.isTrue(interrupted)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(disposing)
				yield* Fiber.join(updating)
				yield* fork.await
				const observed = yield* Fiber.join(states)
				assert.strictEqual(
					Array.last(observed).pipe(
						Option.map((state) => state._tag),
						Option.getOrThrow,
					),
					"Disposed",
				)
				assert.strictEqual(
					Array.filter(observed, (state) => state._tag === "Disposed").length,
					1,
				)
			}).pipe(run),
	)
})
