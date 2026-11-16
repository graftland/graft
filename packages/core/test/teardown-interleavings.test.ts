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
	Scope,
	Stream,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import type { Mount as MountHandle } from "../src/Mount.ts"
import { makeJournal, reach, registrySnapshot, run } from "./b1c-utils.ts"

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
				const { runtime } = Context.get(context, RuntimeContext)
				const released = yield* Ref.make(false)
				yield* Graft.publish(Service, "root").pipe(
					Effect.provideContext(context),
					Effect.provideService(Scope.Scope, rootScope),
				)
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.addFinalizer(() => Ref.set(released, true)),
					),
					{ name: "root consumer", requires: [Service] },
				).pipe(Effect.provideContext(context))
				yield* consumer.await
				yield* Scope.close(rootScope, Exit.void)
				yield* reach(consumer, "Pending")
				const cleaned = yield* Ref.get(released)
				const registry = yield* registrySnapshot(runtime)
				assert.isTrue(cleaned)
				assert.strictEqual(HashMap.size(registry), 0)
				yield* consumer.unmount
			}).pipe(Effect.scoped),
	)

	it.effect(
		"drains a child consuming its parent's service before releasing the parent",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const journal = yield* makeJournal
				const closing = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const child = Layer.effectDiscard(
					Effect.addFinalizer(() =>
						Deferred.succeed(closing, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.andThen(journal.record("child released")),
						),
					),
				)
				const childRef = yield* Deferred.make<MountHandle>()
				const parent = Layer.merge(
					Layer.succeed(Service, "parent"),
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() =>
								journal.record("parent released"),
							)
							const consumer = yield* Graft.mount(child, {
								name: "child consumer",
								requires: [Service],
							})
							yield* Deferred.succeed(childRef, consumer)
						}),
					),
				)
				const mounted = yield* Graft.mount(parent, { name: "parent provider" })
				const consumer = yield* Deferred.await(childRef)
				yield* reach(consumer, "Active")
				const disposing = yield* Effect.forkScoped(mounted.unmount)
				yield* Deferred.await(closing)
				yield* journal.expect([])
				const registry = yield* registrySnapshot(runtime)
				assert.isFalse(HashMap.has(registry, realmKey("", Service.key)))
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(disposing)
				yield* journal.expect(["child released", "parent released"])
				const tree = yield* Stream.runHead(Graft.mounts)
				assert.deepStrictEqual(Option.getOrThrow(tree), [])
			}).pipe(run),
	)

	it.effect(
		"settles restart callers and terminates state streams when unmount interrupts a restart",
		() =>
			Effect.gen(function* () {
				const closing = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.addFinalizer(() =>
							Deferred.succeed(closing, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
							),
						),
					),
					{ name: "disposed restart" },
				)
				yield* mount.await
				const states = yield* Effect.forkScoped(Stream.runCollect(mount.state))
				const restarting = yield* Effect.forkScoped(mount.restart)
				yield* Deferred.await(closing)
				const disposing = yield* Effect.forkScoped(mount.unmount)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(disposing)
				yield* Fiber.join(restarting)
				yield* mount.await
				const observed = yield* Fiber.join(states)
				assert.strictEqual(
					Array.last(observed).pipe(
						Option.map((state) => state._tag),
						Option.getOrThrow,
					),
					"Unmounted",
				)
				assert.strictEqual(
					Array.filter(observed, (state) => state._tag === "Unmounted").length,
					1,
				)
			}).pipe(run),
	)
})
