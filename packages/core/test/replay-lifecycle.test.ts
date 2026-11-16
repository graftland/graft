/**
 * Replayed lifecycle regressions from the 0.6 line: an update is followed by a
 * worker failure, updates compete, state frames are not repeated, emitted tree
 * snapshots stay historical, and consumers may still reach their provider's
 * worker while they clean up.
 */
import {
	Array,
	Cause,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Queue,
	Ref,
	Schedule,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Mount } from "../src/index.ts"
import { reach, run } from "./utils.ts"

const causeText = (cause: Cause.Cause<unknown>) => Cause.pretty(cause)

describe("accepted configuration across a worker failure", () => {
	class Setting extends Context.Service<Setting, string>()(
		"@graftland/graft/test/replay-lifecycle.test/Setting",
	) {}

	it.effect(
		"retries a failed worker with the value accepted by an update",
		() =>
			Effect.gen(function* () {
				const fail = yield* Deferred.make<void>()
				const seen = yield* Ref.make<ReadonlyArray<string>>([])
				// Each build reports its accepted value only after its worker is
				// installed, so the test never mistakes an old Active for the new one.
				const builds = yield* Queue.unbounded<string>()
				const failures = yield* Ref.make(0)
				const firstFailure = yield* Deferred.make<void>()
				const retryFailure = yield* Deferred.make<void>()
				// A retry may only start after its delay is registered on the test
				// clock, so this clock wrapper reports every non-zero sleep to the
				// test. Taking an entry means the retry's sleep is registered, which
				// lets the test advance that one delay instead of guessing.
				const sleeps = yield* Queue.unbounded<Duration.Duration>()
				const clock = yield* Clock.Clock
				const observed: Clock.Clock = {
					...clock,
					sleep: (duration) =>
						Duration.toMillis(duration) > 0
							? Effect.andThen(
									Queue.offer(sleeps, duration),
									clock.sleep(duration),
								)
							: clock.sleep(duration),
				}
				const provider = yield* Graft.publish(Setting, "initial")
				yield* provider.await
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const setting = yield* Setting
							yield* Ref.update(seen, Array.append(setting))
							yield* Graft.fork(
								Deferred.await(fail).pipe(
									Effect.andThen(Effect.fail("late failure")),
								),
							)
							// Report after this build installed its worker; the mount turns
							// Active once the layer body returns, so taking this value and
							// reaching Active both belong to the accepted build.
							yield* Queue.offer(builds, setting)
						}),
					),
					{
						name: "accepted configuration",
						requires: [Setting],
						retry: Schedule.recurs(1),
					},
				).pipe(Effect.provideService(Clock.Clock, observed))
				yield* consumer.await
				const initialBuild = yield* Queue.take(builds)
				assert.strictEqual(initialBuild, "initial")
				// Subscribe before the failure so neither Failed frame is missed.
				const collected = yield* consumer.state.pipe(
					Stream.tap((state) =>
						state._tag === "Failed"
							? Ref.updateAndGet(failures, (count) => count + 1).pipe(
									Effect.flatMap((count) =>
										count === 1
											? Deferred.succeed(firstFailure, undefined)
											: count === 2
												? Deferred.succeed(retryFailure, undefined)
												: Effect.void,
									),
								)
							: Effect.void,
					),
					Stream.runDrain,
					Effect.forkScoped,
				)
				yield* provider.set("accepted")
				// Wait for the accepted build's worker, then for that build to be
				// Active. Neither reads the old Active.
				const acceptedBuild = yield* Queue.take(builds)
				assert.strictEqual(acceptedBuild, "accepted")
				yield* reach(consumer, "Active")
				yield* Deferred.succeed(fail, undefined)
				// The first worker failure is published before any retry begins.
				yield* Deferred.await(firstFailure)
				// Subscribe the await before advancing the clock so its result is
				// observed rather than polled for.
				const awaited = yield* Effect.forkScoped(Effect.exit(consumer.await))
				const retrySleep = yield* Queue.take(sleeps)
				assert.strictEqual(Duration.toMillis(retrySleep), 1)
				yield* TestClock.adjust("1 millis")
				yield* Deferred.await(retryFailure)
				const values = yield* Ref.get(seen)
				const failuresSeen = yield* Ref.get(failures)
				const unslept = yield* Queue.size(sleeps)
				// The first attempt used the old value; the update rebuilt the
				// mount, and both the failing attempt and its retry used the
				// accepted value instead of the stale one.
				assert.deepStrictEqual(values, ["initial", "accepted", "accepted"])
				assert.strictEqual(failuresSeen, 2)
				// Nothing but the retry's delay scheduled work on the clock.
				assert.strictEqual(unslept, 0)
				const exit = yield* Fiber.join(awaited)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.include(causeText(exit.cause), "late failure")
				yield* consumer.unmount
				yield* Fiber.join(collected)
				yield* provider.unmount
			}).pipe(run),
	)
})

describe("competing updates", () => {
	it.effect("publishes one failure from the latest accepted update", () =>
		Effect.gen(function* () {
			const starts = yield* Ref.make(0)
			const blocked = yield* Queue.unbounded<number>()
			const gate = yield* Deferred.make<void>()
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const attempt = yield* Ref.updateAndGet(starts, (n) => n + 1)
						// The first build succeeds; later builds wait until both
						// restarts have been accepted so the older one can be preempted.
						if (attempt === 1) return
						yield* Queue.offer(blocked, attempt)
						yield* Deferred.await(gate)
						yield* Graft.fork(Effect.fail(`update failure ${attempt}`))
						return yield* Effect.never
					}),
				),
				{ name: "competing updates" },
			)
			const frames = yield* Ref.make<ReadonlyArray<Mount.MountState>>([])
			const subscribed = yield* Deferred.make<void>()
			const collected = yield* mount.state.pipe(
				Stream.tap((state) =>
					Ref.update(frames, Array.append(state)).pipe(
						Effect.andThen(Deferred.succeed(subscribed, undefined)),
					),
				),
				Stream.runDrain,
				Effect.forkScoped,
			)
			yield* Deferred.await(subscribed)
			yield* mount.await
			const first = yield* Effect.forkScoped(mount.restart)
			const preemptedAttempt = yield* Queue.take(blocked)
			assert.strictEqual(preemptedAttempt, 2)
			const second = yield* Effect.forkScoped(mount.restart)
			const latestAttempt = yield* Queue.take(blocked)
			assert.strictEqual(latestAttempt, 3)
			yield* Fiber.join(first)
			yield* Fiber.join(second)
			yield* Deferred.succeed(gate, undefined)
			yield* reach(mount, "Failed")
			// Only the latest accepted build started a worker; the preempted
			// one never produced a second failure or a retry.
			const attemptCount = yield* Ref.get(starts)
			assert.strictEqual(attemptCount, 3)
			const exit = yield* Effect.exit(mount.await)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.include(causeText(exit.cause), "update failure 3")
			yield* mount.unmount
			yield* Fiber.join(collected)
			const seen = yield* Ref.get(frames)
			assert.deepStrictEqual(
				Array.map(seen, (state) => state._tag),
				["Loading", "Active", "Loading", "Failed", "Unmounted"],
			)
			assert.strictEqual(
				Array.filter(seen, (state) => state._tag === "Failed").length,
				1,
			)
		}).pipe(run),
	)
})

describe("deduplicated state notifications", () => {
	it.effect("notifies one Loading state while competing restarts rebuild", () =>
		Effect.gen(function* () {
			const starts = yield* Ref.make(0)
			const blocked = yield* Queue.unbounded<number>()
			const gate = yield* Deferred.make<void>()
			const mount = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const attempt = yield* Ref.updateAndGet(starts, (n) => n + 1)
						yield* Queue.offer(blocked, attempt)
						yield* Deferred.await(gate)
					}),
				),
				{ name: "rebuilding" },
			)
			const frames = yield* Ref.make<ReadonlyArray<Mount.MountState>>([])
			const subscribed = yield* Deferred.make<void>()
			const collected = yield* mount.state.pipe(
				Stream.tap((state) =>
					Ref.update(frames, Array.append(state)).pipe(
						Effect.andThen(Deferred.succeed(subscribed, undefined)),
					),
				),
				Stream.runDrain,
				Effect.forkScoped,
			)
			yield* Deferred.await(subscribed)
			const firstAttempt = yield* Queue.take(blocked)
			assert.strictEqual(firstAttempt, 1)
			const first = yield* Effect.forkScoped(mount.restart)
			const secondAttempt = yield* Queue.take(blocked)
			assert.strictEqual(secondAttempt, 2)
			const second = yield* Effect.forkScoped(mount.restart)
			const thirdAttempt = yield* Queue.take(blocked)
			assert.strictEqual(thirdAttempt, 3)
			yield* Fiber.join(first)
			yield* Fiber.join(second)
			yield* Deferred.succeed(gate, undefined)
			yield* reach(mount, "Active")
			yield* mount.unmount
			yield* Fiber.join(collected)
			// Three builds started, but the subscriber sees Loading once.
			const attemptCount = yield* Ref.get(starts)
			assert.strictEqual(attemptCount, 3)
			const seen = yield* Ref.get(frames)
			assert.deepStrictEqual(seen, [
				Mount.MountState.Loading(),
				Mount.MountState.Active(),
				Mount.MountState.Unmounted(),
			])
		}).pipe(run),
	)
})

describe("historical tree snapshots", () => {
	it.effect("keeps an emitted mount tree unchanged by a later update", () =>
		Effect.gen(function* () {
			const registered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const parentGate = yield* Deferred.make<void>()
			const child = Layer.effectDiscard(
				Effect.gen(function* () {
					yield* Deferred.succeed(registered, undefined)
					yield* Deferred.await(release)
				}),
			)
			const parent = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						yield* Graft.mount(child, { name: "historical child" })
						yield* Deferred.await(registered)
						// Hold the parent in Loading until the test captured the first
						// frame, so the snapshot is deterministic rather than racing
						// the parent's own transition to Active.
						yield* Deferred.await(parentGate)
					}),
				),
				{ name: "historical parent" },
			)
			yield* Deferred.await(registered)

			// One sustained subscription to the same stream; every frame, the
			// first included, is read from this queue.
			const frames = yield* Queue.unbounded<ReadonlyArray<Mount.MountTree>>()
			const collected = yield* Graft.mounts.pipe(
				Stream.tap((frame) => Queue.offer(frames, frame)),
				Stream.runDrain,
				Effect.forkScoped,
			)
			const takeFrameUntil = (
				predicate: (frame: ReadonlyArray<Mount.MountTree>) => boolean,
			) =>
				Effect.gen(function* () {
					let frame = yield* Queue.take(frames)
					while (!predicate(frame)) frame = yield* Queue.take(frames)
					return frame
				})
			const hasLoading = (frame: ReadonlyArray<Mount.MountTree>) =>
				Array.some(
					frame,
					(node) =>
						node.state._tag === "Loading" ||
						Array.some(
							node.children,
							(child) => child.state._tag === "Loading",
						),
				)
			const allActive = (frame: ReadonlyArray<Mount.MountTree>) =>
				Array.every(
					frame,
					(node) =>
						node.state._tag === "Active" &&
						Array.every(
							node.children,
							(child) => child.state._tag === "Active",
						),
				)

			const before = yield* Queue.take(frames)
			const copy = structuredClone(before)
			// The child is still building in this frame.
			assert.deepStrictEqual(
				Array.map(before, (node) => node.state._tag),
				["Loading"],
			)
			assert.deepStrictEqual(
				Array.map(
					Option.getOrThrow(Array.head(before)).children,
					(node) => node.state._tag,
				),
				["Loading"],
			)

			// The child and then the parent become Active; the same subscription
			// sees those frames.
			yield* Deferred.succeed(release, undefined)
			yield* Deferred.succeed(parentGate, undefined)
			yield* parent.stable
			const after = yield* takeFrameUntil(allActive)
			assert.deepStrictEqual(
				Array.map(after, (node) => node.state._tag),
				["Active"],
			)
			assert.deepStrictEqual(
				Array.map(
					Option.getOrThrow(Array.head(after)).children,
					(node) => node.state._tag,
				),
				["Active"],
			)

			// A restart keeps producing frames on the same subscription.
			yield* parent.restart
			yield* takeFrameUntil(hasLoading)
			yield* takeFrameUntil(allActive)

			// The frame captured before every change is still exactly what it was.
			assert.deepStrictEqual(before, copy)
			yield* parent.unmount
			// The stream never ends; stop the sustained subscription explicitly.
			yield* Fiber.interrupt(collected)
		}).pipe(run),
	)
})

describe("provider worker during consumer cleanup", () => {
	class Rpc extends Context.Service<
		Rpc,
		{
			readonly ping: Effect.Effect<void>
			readonly stopped: Deferred.Deferred<void>
		}
	>()("@graftland/graft/test/replay-lifecycle.test/Rpc") {}

	const serve = Layer.effect(
		Rpc,
		Effect.gen(function* () {
			const requests = yield* Queue.unbounded<Deferred.Deferred<void>>()
			const stopped = yield* Deferred.make<void>()
			yield* Graft.fork(
				Effect.forever(
					Queue.take(requests).pipe(
						Effect.flatMap((reply) => Deferred.succeed(reply, undefined)),
					),
				).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
			)
			const ping = Effect.gen(function* () {
				const reply = yield* Deferred.make<void>()
				yield* Queue.offer(requests, reply)
				yield* Deferred.await(reply)
			})
			return { ping, stopped }
		}),
	)

	it.effect.each(["unmount", "restart"] as const)(
		"serves a consumer's finalizer calls during %s",
		(change) =>
			Effect.gen(function* () {
				const finalizing = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const served = yield* Deferred.make<boolean>()
				const workerAlive = yield* Deferred.make<boolean>()
				const provider = yield* Graft.mount(serve, { name: "queue provider" })
				yield* provider.await
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const rpc = yield* Rpc
							yield* rpc.ping
							yield* Effect.addFinalizer(() =>
								Effect.gen(function* () {
									yield* Deferred.succeed(finalizing, undefined)
									yield* Deferred.await(release)
									const stopped = yield* Deferred.isDone(rpc.stopped)
									yield* Deferred.succeed(workerAlive, stopped)
									yield* rpc.ping
									yield* Deferred.succeed(served, true)
								}),
							)
						}),
					),
					{ name: "queue consumer", requires: [Rpc] },
				)
				yield* consumer.await
				const done = yield* Deferred.make<void>()
				const teardown = yield* Effect.forkScoped(
					(change === "unmount" ? provider.unmount : provider.restart).pipe(
						Effect.andThen(Deferred.succeed(done, undefined)),
					),
				)
				yield* Deferred.await(finalizing)
				// The provider is tearing down but its worker is still serving.
				const finished = yield* Deferred.isDone(done)
				assert.isFalse(finished)
				yield* Deferred.succeed(release, undefined)
				const answered = yield* Deferred.await(served)
				assert.isTrue(answered)
				const alive = yield* Deferred.await(workerAlive)
				assert.isFalse(alive)
				yield* Fiber.join(teardown)
				yield* provider.unmount
			}).pipe(run),
	)
})
