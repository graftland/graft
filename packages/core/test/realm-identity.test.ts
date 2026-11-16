import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Layer,
	Option,
	Pull,
	Ref,
	Schedule,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { reach, run } from "./b1b-utils.ts"

/**
 * Advances virtual time in 1ms steps, yielding between steps so the retry
 * sleep is registered before the next adjustment wakes it.
 */
const advanceRetry = Effect.repeat(
	Effect.andThen(Effect.yieldNow, TestClock.adjust("1 millis")),
	Schedule.recurs(4),
)

// @effect-diagnostics-next-line deterministicKeys:off -- Deliberately contains the old identity separator.
class Secret extends Context.Service<Secret, string>()("prefix\u0000value") {}
// @effect-diagnostics-next-line deterministicKeys:off -- Deliberately matches the suffix of Secret's key.
class Other extends Context.Service<Other, string>()("value") {}
class Bridge extends Context.Service<Bridge, string>()(
	"@graftland/graft/test/realm-identity.test/Bridge",
) {}

const secretProvider = Graft.mount(Layer.succeed(Secret, "private secret"), {
	name: "secret provider",
	isolate: [[Secret, "tenant"]],
})
const otherProvider = Graft.mount(Layer.succeed(Other, "other value"), {
	name: "other provider",
	isolate: [[Other, "tenant\u0000prefix"]],
})
const secretRealm = { isolate: [[Secret, "tenant"]] as const }
const otherRealm = { isolate: [[Other, "tenant\u0000prefix"]] as const }

describe("realm identity", () => {
	it.effect(
		"does not satisfy a required dependency with another realm and service pair",
		() =>
			Effect.gen(function* () {
				const provider = yield* Graft.mount(
					Layer.succeed(Secret, "private secret"),
					{ name: "secret provider", ...secretRealm },
				)
				yield* provider.await
				const seen = yield* Ref.make(Option.none<string>())
				const consumer = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.flatMap(Effect.serviceOption(Secret), (value) =>
							Ref.set(seen, value),
						),
					),
					{ name: "required consumer", requires: [Other], ...otherRealm },
				)
				yield* TestClock.adjust("1 millis")
				const snapshot = yield* Stream.runHead(consumer.state)
				const state = Option.getOrThrow(snapshot)
				assert.strictEqual(state._tag, "Pending")
				const value = yield* Ref.get(seen)
				assert.deepStrictEqual(value, Option.none())
			}).pipe(run),
	)

	it.effect("publishes and withdraws distinct pairs independently", () =>
		Effect.gen(function* () {
			const secret = yield* secretProvider
			yield* secret.await
			const other = yield* otherProvider
			yield* other.await
			const secretReader = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const value = yield* Secret
						const other = yield* Effect.serviceOption(Other)
						assert.strictEqual(value, "private secret")
						assert.deepStrictEqual(other, Option.none())
					}),
				),
				{ name: "secret consumer", requires: [Secret], ...secretRealm },
			)
			yield* secretReader.await
			const observed = yield* Ref.make<ReadonlyArray<string>>([])
			const consumer = yield* Graft.mount(
				Layer.effectDiscard(
					Effect.gen(function* () {
						const value = yield* Other
						const leaked = yield* Effect.serviceOption(Secret)
						assert.deepStrictEqual(leaked, Option.none())
						yield* Ref.update(observed, Array.append(value))
					}),
				),
				{ name: "other consumer", requires: [Other], ...otherRealm },
			)
			yield* consumer.await
			yield* secret.unmount
			yield* TestClock.adjust("1 millis")
			const values = yield* Ref.get(observed)
			assert.deepStrictEqual(values, ["other value"])
			yield* other.unmount
			yield* reach(consumer, "Pending")
		}).pipe(run),
	)

	for (const ambient of [false, true]) {
		it.effect(
			`does not restart ${ambient ? "ambient" : "absent optional"} watchers for another pair`,
			() =>
				Effect.gen(function* () {
					const starts = yield* Ref.make(0)
					const consumer = yield* Graft.mount(
						Layer.effectDiscard(
							Effect.gen(function* () {
								const fallback = yield* Effect.serviceOption(Other)
								const leaked = yield* Effect.serviceOption(Secret)
								assert.deepStrictEqual(
									fallback,
									ambient ? Option.some("ambient") : Option.none(),
								)
								assert.deepStrictEqual(leaked, Option.none())
								yield* Ref.update(starts, (n) => n + 1)
							}),
						),
						{
							name: "fallback consumer",
							requires: [ambient ? Other : Graft.optional(Other)],
							...otherRealm,
						},
					)
					yield* consumer.await
					const provider = yield* secretProvider
					yield* provider.await
					yield* TestClock.adjust("1 millis")
					const afterPublication = yield* Ref.get(starts)
					assert.strictEqual(afterPublication, 1)
					const snapshot = yield* Stream.runHead(consumer.state)
					assert.strictEqual(Option.getOrThrow(snapshot)._tag, "Active")
					yield* provider.unmount
					yield* TestClock.adjust("1 millis")
					const afterWithdrawal = yield* Ref.get(starts)
					assert.strictEqual(afterWithdrawal, 1)
				}).pipe(
					Effect.scoped,
					Effect.provide(
						Layer.fresh(
							ambient
								? Graft.layer.pipe(
										Layer.provide(Layer.succeed(Other, "ambient")),
									)
								: Graft.layer,
						),
					),
				),
		)
	}

	it.effect(
		"does not reject a child's unrelated publication as a dependency cycle",
		() =>
			Effect.gen(function* () {
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const child = yield* Graft.mount(
								Layer.succeed(Secret, "private secret"),
								{ name: "secret", ...secretRealm },
							)
							yield* child.await
						}),
					),
					{
						name: "watching parent",
						requires: [Graft.optional(Other)],
						...otherRealm,
					},
				)
				yield* parent.await
			}).pipe(run),
	)

	it.effect(
		"rechecks a rejected publication with the same structural identity",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0)
				const owner = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const published = yield* Graft.mount(
								Layer.succeed(Bridge, "bridge"),
								{ name: "bridge" },
							)
							yield* published.await
						}),
					),
					{ name: "watcher", requires: [Graft.optional(Other)], ...otherRealm },
				)
				yield* owner.await
				const publisher = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* Ref.update(attempts, (n) => n + 1)
							const published = yield* Graft.mount(
								Layer.succeed(Other, "published"),
								{ name: "publisher publication" },
							)
							yield* published.await
						}),
					),
					{ name: "cyclic publisher", requires: [Bridge], ...otherRealm },
				)
				yield* reach(publisher, "Failed")
				const unrelated = yield* secretProvider
				yield* unrelated.await
				yield* unrelated.unmount
				yield* TestClock.adjust("1 millis")
				const before = yield* Ref.get(attempts)
				assert.strictEqual(before, 1)
				// Dropping the watcher's dependency breaks the cycle for an independent provider.
				yield* owner.unmount
				yield* Effect.flatMap(
					Graft.mount(Layer.succeed(Bridge, "bridge"), {
						name: "independent provider",
						...otherRealm,
					}),
					(mount) => mount.await,
				)
				yield* reach(publisher, "Active")
				const after = yield* Ref.get(attempts)
				assert.strictEqual(after, 2)
			}).pipe(run),
	)

	it.effect(
		"does not replenish retries when unresolved keys are reconstructed",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0)
				const exhausted = yield* Deferred.make<void>()
				const retry = Schedule.fromStep(
					Effect.map(
						Schedule.toStep(Schedule.recurs(1)),
						(step) => (now: number, input: unknown) =>
							step(now, input).pipe(
								Pull.catchDone((last) =>
									Deferred.succeed(exhausted, undefined).pipe(
										Effect.andThen(Cause.done(last)),
									),
								),
							),
					),
				)
				const mount = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
							// A third attempt would succeed, exposing a replenished budget without looping forever.
							if (attempt <= 2) return yield* Effect.fail("still failing")
						}),
					),
					{
						name: "bounded retries with an optional dependency",
						requires: [Graft.optional(Other)],
						retry,
						...otherRealm,
					},
				)
				yield* advanceRetry
				yield* Effect.raceFirst(
					Deferred.await(exhausted),
					reach(mount, "Active"),
				)
				const count = yield* Ref.get(attempts)
				const snapshot = yield* Stream.runHead(mount.state)
				assert.strictEqual(count, 2)
				assert.strictEqual(Option.getOrThrow(snapshot)._tag, "Failed")
			}).pipe(run),
	)

	it.effect(
		"keeps private and root realms separate from prefix-like and empty labels",
		() =>
			Effect.gen(function* () {
				const root = yield* Graft.mount(Layer.succeed(Other, "root"), {
					name: "root",
				})
				yield* root.await
				const privateRoom = yield* Graft.mount(
					Layer.succeed(Other, "private"),
					{ name: "private", isolate: [Other] },
				)
				yield* privateRoom.await
				for (const label of [
					"",
					`#${privateRoom.id}`,
					"@tenant",
					"tenant\u0000prefix",
				]) {
					const provider = yield* Graft.mount(
						Layer.succeed(Other, `label ${label}`),
						{ name: `label ${label}`, isolate: [[Other, label]] },
					)
					yield* provider.await
					const consumer = yield* Graft.mount(
						Layer.effectDiscard(
							Effect.flatMap(Other, (value) =>
								Effect.sync(() => assert.strictEqual(value, `label ${label}`)),
							),
						),
						{
							name: "shared reader",
							requires: [Other],
							isolate: [[Other, label]],
						},
					)
					yield* consumer.await
				}
				const value = yield* Graft.await(Other)
				assert.strictEqual(value, "root")
			}).pipe(run),
	)
})
