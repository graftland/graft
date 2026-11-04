import { RuntimeContext } from "../src/internal/runtimeContext"
import { registrySnapshot } from "./utils.ts"
import { assert, describe, it } from "@effect/vitest"
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
	Option,
	PubSub,
	Ref,
	Schema,
	Stream,
	String,
	TxRef,
} from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { reach, run } from "./utils.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/regressions.test/Service",
) {}
class Other extends Context.Service<Other, string>()(
	"@graftland/graft/test/regressions.test/Other",
) {}
const settle = Effect.forEach(Array.range(1, 50), () => Effect.yieldNow, {
	discard: true,
})

describe("regressions", () => {
	it.effect(
		"releases a dependency lease even if a scope finalizer defects",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const provider = yield* Graft.plugin(
					Plugin.service(Service, Effect.succeed("ready"), {
						name: "provider",
					}),
				)
				yield* provider.await
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "consumer",
						inject: [Service],
						apply: () =>
							Effect.addFinalizer(() => Effect.die("release failed")),
					}),
				)
				yield* consumer.await
				const registry = yield* registrySnapshot(runtime)
				const provision = Option.getOrThrow(
					HashMap.get(registry, realmKey("", Service.key)),
				)
				const cleanup = yield* Effect.exit(consumer.dispose)
				assert.isTrue(Exit.isFailure(cleanup))
				const remaining = yield* TxRef.get(provision.consumers)
				// Clear the consumers after observing it, so the regression cannot hang test cleanup.
				yield* TxRef.set(provision.consumers, HashSet.empty())
				yield* provider.dispose
				assert.strictEqual(HashSet.size(remaining), 0)
			}).pipe(run),
	)

	it.effect("keeps an isolated absent optional dependency absent", () =>
		Effect.gen(function* () {
			const seen = yield* Ref.make(Option.none<string>())
			const child = Plugin.make({
				name: "child",
				inject: [Plugin.optional(Service)],
				apply: () =>
					Effect.flatMap(Effect.serviceOption(Service), (value) =>
						Ref.set(seen, value),
					),
			})
			const parent = Plugin.make({
				name: "parent",
				inject: [Service],
				apply: () =>
					Effect.flatMap(
						Graft.plugin(child, undefined, { isolate: [Service] }),
						(fork) => fork.await,
					),
			})
			const provider = yield* Graft.plugin(
				Plugin.service(Service, Effect.succeed("outer"), { name: "provider" }),
			)
			yield* provider.await
			const parentFork = yield* Graft.plugin(parent)
			yield* parentFork.await
			const observed = yield* Ref.get(seen)
			assert.deepStrictEqual(observed, Option.none())
		}).pipe(run),
	)

	it.effect(
		"interrupts an in-place update when its dependency is withdrawn",
		() =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const { runtime } = yield* RuntimeContext
				const provider = yield* Graft.plugin(
					Plugin.service(Service, Effect.succeed("ready"), {
						name: "provider",
					}),
				)
				yield* provider.await
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "consumer",
						inject: [Service],
						config: Schema.String,
						apply: () =>
							Effect.succeed(() =>
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
									Effect.as(true),
								),
							),
					}),
					"before",
				)
				yield* consumer.await
				yield* Effect.forkScoped(consumer.update("after"))
				yield* Deferred.await(started)
				const disposing = yield* Effect.forkScoped(provider.dispose)
				yield* Effect.tx(
					Effect.gen(function* () {
						const registry = yield* registrySnapshot(runtime)
						if (HashMap.has(registry, realmKey("", Service.key)))
							return yield* Effect.txRetry
					}),
				)
				yield* settle
				const finished = disposing.pollUnsafe() !== undefined
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(disposing)
				yield* reach(consumer, "Pending")
				assert.isTrue(finished)
			}).pipe(run),
	)

	it.effect(
		"does not retain a service published during scope finalization",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "late provider",
						apply: () =>
							Effect.addFinalizer(() =>
								Graft.provide(Service, "orphan").pipe(Effect.orDie),
							),
					}),
				)
				yield* fork.await
				const cleanup = yield* Effect.exit(fork.dispose)
				assert.isTrue(Exit.isFailure(cleanup))
				const registry = yield* registrySnapshot(runtime)
				assert.isFalse(HashMap.has(registry, realmKey("", Service.key)))
			}).pipe(run),
	)

	it.effect("passes apply failure to scoped finalizers", () =>
		Effect.gen(function* () {
			const seen = yield* Ref.make("not closed")
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "failing",
					apply: () =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer((exit) => Ref.set(seen, exit._tag))
							return yield* Effect.fail("apply failed")
						}),
				}),
			)
			yield* Effect.exit(fork.await)
			const observed = yield* Ref.get(seen)
			assert.strictEqual(observed, "Failure")
		}).pipe(run),
	)

	it.effect(
		"refreshes Pending.missing after one required service appears",
		() =>
			Effect.gen(function* () {
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "pending",
						inject: [Service, Other],
						apply: () => Effect.void,
					}),
				)
				yield* reach(fork, "Pending")
				yield* Graft.provide(Service, "ready")
				yield* settle
				const snapshot = yield* Stream.runHead(fork.state)
				const state = Option.getOrThrow(snapshot)
				assert.deepStrictEqual(state._tag === "Pending" && state.missing, [
					Other.key,
				])
			}).pipe(run),
	)

	it.effect("retries a failed consumer when its dependency is replaced", () =>
		Effect.gen(function* () {
			const oldProvider = Plugin.service(Service, Effect.succeed("broken"), {
				name: "old provider",
			})
			const newProvider = Plugin.service(Service, Effect.succeed("fixed"), {
				name: "new provider",
			})
			const provider = yield* Graft.plugin(oldProvider)
			yield* provider.await
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "consumer",
					inject: [Service],
					apply: () =>
						Effect.flatMap(Service, (value) =>
							value === "fixed" ? Effect.void : Effect.fail("bad dependency"),
						),
				}),
			)
			yield* Effect.exit(fork.await)
			yield* Graft.replace([[oldProvider, newProvider]])
			yield* reach(provider, "Loading")
			yield* reach(provider, "Active")
			yield* settle
			const snapshot = yield* Stream.runHead(fork.state)
			const state = Option.getOrThrow(snapshot)
			assert.strictEqual(state._tag, "Active")
		}).pipe(run),
	)

	it.effect(
		"can load the original plugin after replacing a version back to it",
		() =>
			Effect.gen(function* () {
				const first = Plugin.make({ name: "first", apply: () => Effect.void })
				const second = Plugin.make({ name: "second", apply: () => Effect.void })
				yield* Graft.replace([[first, second]])
				yield* Graft.replace([[second, first]])
				const fork = yield* Graft.plugin(first)
				yield* fork.await
				const tree = yield* Stream.runHead(Graft.forks)
				assert.deepStrictEqual(
					Option.map(
						tree,
						Array.map((node) => node.name),
					),
					Option.some(["first"]),
				)
			}).pipe(run),
	)

	it.effect("records defects from interrupted apply cleanup", () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const { runtime } = yield* RuntimeContext
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "interrupted cleanup",
					apply: () =>
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(Effect.die("cleanup defect")),
						),
				}),
			)
			yield* Deferred.await(started)
			const cleanup = yield* Effect.exit(fork.dispose)
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
