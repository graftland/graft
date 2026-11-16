import {
	Array,
	Cause,
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
	TxSubscriptionRef,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { realmKey, type Runtime } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import type { Publication } from "../src/Mount.ts"
import { registrySnapshot, run } from "./b1c-utils.ts"

class Rpc extends Context.Service<
	Rpc,
	{ readonly ping: Effect.Effect<void> }
>()("@graftland/graft/test/publish-draining.test/Rpc") {}
class Late extends Context.Service<Late, string>()(
	"@graftland/graft/test/publish-draining.test/Late",
) {}

const refusedMessage = `Cannot publish "${Late.key}": the mount is being torn down`

type Attempt = Exit.Exit<
	Publication<string, Graft.ServiceConflict>,
	Graft.ServiceConflict
>

/** The publication was refused because the mount owning it is tearing down. */
const refused = (cause: Cause.Cause<unknown>) =>
	Array.some(
		cause.reasons,
		(reason) =>
			reason._tag === "Die" &&
			reason.defect instanceof Error &&
			reason.defect.message === refusedMessage,
	)

/** Whether a mount named after the service is registered, whatever its state. */
const mountNamed = Effect.fn("mountNamed")(function* (
	runtime: Runtime,
	service: string,
) {
	const mounts = yield* TxSubscriptionRef.get(runtime.mounts)
	return Array.some(HashMap.toValues(mounts), (entry) => entry.name === service)
})

const inGraph = Effect.fn("inGraph")(function* (runtime: Runtime) {
	const provisions = yield* registrySnapshot(runtime)
	return HashMap.has(provisions, realmKey("", Late.key))
})

/** A consumer of `Rpc` that holds the provider's drain open in its finalizer. */
const holdsDrain = (
	draining: Deferred.Deferred<void>,
	release: Deferred.Deferred<void>,
) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			yield* Rpc
			yield* Effect.addFinalizer(() =>
				Effect.andThen(
					Deferred.succeed(draining, undefined),
					Deferred.await(release),
				),
			)
		}),
	)

const providesRpc = Layer.succeed(Rpc, { ping: Effect.void })

/**
 * Holds a mount's supervisor before it acquires dependencies and builds, which
 * is the state a publication is in once it is registered. Uses the public
 * `intercept` seam, so nothing in the engine is special-cased for tests.
 */
const holdsBuild = (
	entered: Deferred.Deferred<void>,
	resume: Deferred.Deferred<void>,
): Graft.Intercept => ({
	apply: (effect) =>
		Effect.andThen(
			Effect.andThen(
				Deferred.succeed(entered, undefined),
				Deferred.await(resume),
			),
			effect,
		),
})

/** Collects every availability frame of `Late` from before an attempt. */
const watchLate = Effect.gen(function* () {
	const frames = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
	const subscribed = yield* Deferred.make<void>()
	yield* Effect.forkScoped(
		Graft.watch(Late).pipe(
			Stream.tap((value) =>
				Ref.update(frames, Array.append(value)).pipe(
					Effect.andThen(Deferred.succeed(subscribed, undefined)),
				),
			),
			Stream.runDrain,
		),
	)
	yield* Deferred.await(subscribed)
	return frames
})

const everyFrameEmpty = (
	frames: Ref.Ref<ReadonlyArray<Option.Option<string>>>,
) =>
	Effect.map(Ref.get(frames), (collected) =>
		Array.every(collected, (frame) => frame._tag === "None"),
	)

describe("publishing from a draining mount", () => {
	it.effect(
		"refuses a publication whose mount has already begun tearing down",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const late = yield* Deferred.make<void>()
				const draining = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const outcome = yield* Deferred.make<Attempt>()
				const publicationScope = yield* Scope.make()
				const provider = yield* Graft.mount(
					Layer.merge(
						providesRpc,
						Layer.effectDiscard(
							Graft.fork(
								Effect.gen(function* () {
									yield* Deferred.await(late)
									const exit = yield* Effect.exit(
										Scope.provide(
											Graft.publish(Late, "too late"),
											publicationScope,
										),
									)
									yield* Deferred.succeed(outcome, exit)
								}),
							),
						),
					),
					{ name: "provider" },
				)
				yield* provider.await
				const consumer = yield* Graft.mount(holdsDrain(draining, release), {
					name: "held consumer",
					requires: [Rpc],
				})
				yield* consumer.await
				const frames = yield* watchLate
				const beforeAttempt = yield* inGraph(runtime)
				assert.isFalse(beforeAttempt, "not published before the attempt")

				const closing = yield* Effect.forkScoped(Effect.exit(provider.unmount))
				// Withdraw has committed by now: the consumer is tearing down.
				yield* Deferred.await(draining)
				yield* Deferred.succeed(late, undefined)
				const exit = yield* Deferred.await(outcome)

				assert.isTrue(Exit.isFailure(exit), "the publication must be refused")
				if (Exit.isFailure(exit)) assert.isTrue(refused(exit.cause))
				const handle = yield* mountNamed(runtime, Late.key)
				assert.isFalse(handle, "a refused publication leaves no handle behind")
				const duringDrain = yield* inGraph(runtime)
				assert.isFalse(duringDrain)

				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(closing)
				const afterDrain = yield* inGraph(runtime)
				assert.isFalse(afterDrain)
				const leftover = yield* mountNamed(runtime, Late.key)
				assert.isFalse(leftover)
				assert.notStrictEqual(publicationScope.state._tag, "Closed")
				const empty = yield* everyFrameEmpty(frames)
				assert.isTrue(
					empty,
					"a refused publication must never make the service available",
				)
			}).pipe(run),
	)

	it.effect(
		"takes a registered publication down with the mount that owns it",
		() =>
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const entered = yield* Deferred.make<void>()
				const resume = yield* Deferred.make<void>()
				const draining = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const registered =
					yield* Deferred.make<Publication<string, Graft.ServiceConflict>>()
				const publicationScope = yield* Scope.make()
				const provider = yield* Graft.mount(
					Layer.merge(
						providesRpc,
						Layer.effectDiscard(
							Graft.fork(
								Effect.gen(function* () {
									const publication = yield* Scope.provide(
										Graft.publish(Late, "too late", {
											intercept: [holdsBuild(entered, resume)],
										}),
										publicationScope,
									)
									yield* Deferred.succeed(registered, publication)
								}),
							),
						),
					),
					{ name: "provider" },
				)
				yield* provider.await
				const consumer = yield* Graft.mount(holdsDrain(draining, release), {
					name: "held consumer",
					requires: [Rpc],
				})
				yield* consumer.await
				const frames = yield* watchLate
				const publication = yield* Deferred.await(registered)
				// The mount is registered, its build is held before it publishes.
				yield* Deferred.await(entered)
				const beforeDrain = yield* inGraph(runtime)
				assert.isFalse(beforeDrain)
				const held = yield* mountNamed(runtime, Late.key)
				assert.isTrue(held, "the publication is registered before it is held")

				const closing = yield* Effect.forkScoped(Effect.exit(provider.unmount))
				yield* Deferred.await(draining)
				const duringDrain = yield* inGraph(runtime)
				assert.isFalse(duringDrain, "a draining owner must not publish late")
				yield* Deferred.succeed(resume, undefined)

				const failed = yield* publication.state.pipe(
					Stream.filter((state) => state._tag === "Failed"),
					Stream.runHead,
				)
				assert.isTrue(Option.isSome(failed), "the held publication must fail")
				if (Option.isSome(failed) && failed.value._tag === "Failed")
					assert.isTrue(refused(failed.value.cause))

				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(closing)

				const collected = yield* Stream.runCollect(publication.state)
				const states = Array.fromIterable(collected)
				const last = states[states.length - 1]
				assert.isTrue(
					last !== undefined && last._tag === "Unmounted",
					"the publication's mount is torn down with its owner",
				)
				const afterDrain = yield* inGraph(runtime)
				assert.isFalse(afterDrain)
				const leftover = yield* mountNamed(runtime, Late.key)
				assert.isFalse(leftover)
				// The caller's scope is still open, so a leak would still be visible.
				assert.notStrictEqual(publicationScope.state._tag, "Closed")
				const empty = yield* everyFrameEmpty(frames)
				assert.isTrue(
					empty,
					"a publication from a draining mount must never become available",
				)
			}).pipe(run),
	)
})
