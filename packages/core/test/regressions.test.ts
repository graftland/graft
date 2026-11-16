import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	HashSet,
	Layer,
	Option,
	PubSub,
	Ref,
	Stream,
	String,
	TxRef,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { reach, registrySnapshot, run } from "./b1b-utils.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/regressions.test/Service",
) {}
class Other extends Context.Service<Other, string>()(
	"@graftland/graft/test/regressions.test/Other",
) {}

describe("regressions", () => {
	it.effect(
		"releases a dependency lease even if a scope finalizer defects",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const provider = yield* Graft.mount(Layer.succeed(Service, "ready"), {
					name: "provider",
				})
				yield* provider.await
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.addFinalizer(() => Effect.die("release failed")),
					),
					{ name: "consumer", requires: [Service] },
				)
				yield* consumer.await
				const registry = yield* registrySnapshot(runtime)
				const provision = Option.getOrThrow(
					HashMap.get(registry, realmKey("", Service.key)),
				)
				const cleanup = yield* Effect.exit(consumer.unmount)
				assert.isTrue(Exit.isFailure(cleanup))
				const remaining = yield* TxRef.get(provision.consumers)
				// Clear the consumers after observing it, so the regression cannot hang test cleanup.
				yield* TxRef.set(provision.consumers, HashSet.empty())
				yield* provider.unmount
				assert.strictEqual(HashSet.size(remaining), 0)
			}).pipe(run),
	)

	it.effect("keeps an isolated absent optional dependency absent", () =>
		Effect.gen(function* () {
			const seen = yield* Ref.make(Option.none<string>())
			const provider = yield* Graft.mount(Layer.succeed(Service, "outer"), {
				name: "provider",
			})
			yield* provider.await
			const parent = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const child = yield* Graft.mount(
							Layer.effectDiscard(
								Effect.flatMap(Effect.serviceOption(Service), (value) =>
									Ref.set(seen, value),
								),
							),
							{
								name: "child",
								requires: [Graft.optional(Service)],
								isolate: [Service],
							},
						)
						yield* child.await
					}),
				),
				{ name: "parent", requires: [Service] },
			)
			yield* parent.await
			const observed = yield* Ref.get(seen)
			assert.deepStrictEqual(observed, Option.none())
		}).pipe(run),
	)

	it.effect(
		"interrupts an in-flight rebuild when its dependency is withdrawn",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const attempts = yield* Ref.make(0)
				const provider = yield* Graft.mount(Layer.succeed(Service, "ready"), {
					name: "provider",
				})
				yield* provider.await
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Service
							const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
							if (attempt === 2) {
								yield* Deferred.succeed(started, undefined)
								yield* Deferred.await(release)
							}
						}),
					),
					{ name: "consumer", requires: [Service] },
				)
				yield* consumer.await
				const restarting = yield* Effect.forkScoped(consumer.restart)
				yield* Deferred.await(started)
				const disposing = yield* Effect.forkChild(provider.unmount)
				// Disposal must finish while the rebuild is still blocked; a regression hangs here.
				yield* Fiber.join(disposing)
				yield* Deferred.succeed(release, undefined)
				yield* reach(consumer, "Pending")
				yield* Fiber.interrupt(restarting)
			}).pipe(run),
	)

	it.effect(
		"does not retain a service published during scope finalization",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.addFinalizer(() =>
							Effect.asVoid(Graft.publish(Service, "orphan")),
						),
					),
					{ name: "late provider" },
				)
				yield* mount.await
				// Publishing during finalization may fail or be unmounted at once; either way nothing survives.
				yield* Effect.exit(mount.unmount)
				const registry = yield* registrySnapshot(runtime)
				assert.isFalse(HashMap.has(registry, realmKey("", Service.key)))
			}).pipe(run),
	)

	it.effect("passes layer failure to scoped finalizers", () =>
		Effect.gen(function* () {
			const seen = yield* Ref.make("not closed")
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						yield* Effect.addFinalizer((exit) => Ref.set(seen, exit._tag))
						return yield* Effect.fail("apply failed")
					}),
				),
				{ name: "failing" },
			)
			yield* Effect.exit(mount.await)
			const observed = yield* Ref.get(seen)
			assert.strictEqual(observed, "Failure")
		}).pipe(run),
	)

	it.effect(
		"refreshes Pending.missing after one required service appears",
		() =>
			Effect.gen(function* () {
				const mount = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
					name: "pending",
					requires: [Service, Other],
				})
				yield* reach(mount, "Pending")
				yield* Graft.publish(Service, "ready")
				const snapshot = yield* mount.state.pipe(
					Stream.filter(
						(state) => state._tag === "Pending" && state.missing.length === 1,
					),
					Stream.runHead,
				)
				const state = Option.getOrThrow(snapshot)
				assert.deepStrictEqual(state._tag === "Pending" && state.missing, [
					Other.key,
				])
			}).pipe(run),
	)

	it.effect("retries a failed consumer when its dependency is replaced", () =>
		Effect.gen(function* () {
			const provider = yield* Graft.mount(Layer.succeed(Service, "broken"), {
				name: "old provider",
			})
			yield* provider.await
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.flatMap(Service, (value) =>
						value === "fixed" ? Effect.void : Effect.fail("bad dependency"),
					),
				),
				{ name: "consumer", requires: [Service] },
			)
			yield* Effect.exit(mount.await)
			yield* provider.unmount
			yield* Effect.flatMap(
				Graft.mount(Layer.succeed(Service, "fixed"), { name: "new provider" }),
				(provider) => provider.await,
			)
			yield* reach(mount, "Active")
		}).pipe(run),
	)

	it.effect("records defects from interrupted layer cleanup", () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const { runtime } = yield* RuntimeContext
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.ensuring(Effect.die("cleanup defect")),
					),
				),
				{ name: "interrupted cleanup" },
			)
			yield* Deferred.await(started)
			const cleanup = yield* Effect.exit(mount.unmount)
			assert.isTrue(Exit.isFailure(cleanup))
			yield* Effect.log("Review log boundary")
			const subscription = yield* PubSub.subscribe(runtime.logs)
			const entries = yield* PubSub.takeAll(subscription)
			const recorded = Array.some(
				entries,
				({ cause, message }) =>
					String.includes("cleanup defect")(Cause.pretty(cause)) ||
					(Array.isArray(message) &&
						Array.some(
							message,
							(item) =>
								Cause.isCause(item) &&
								String.includes("cleanup defect")(Cause.pretty(item)),
						)),
			)
			assert.isTrue(recorded)
		}).pipe(run),
	)
})
