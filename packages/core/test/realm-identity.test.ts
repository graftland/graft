import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Pull,
	Context,
	Effect,
	Layer,
	Option,
	Ref,
	Schedule,
	Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { Event, Graft, Plugin } from "../src/index.ts"
import { reach, run } from "./utils.ts"

// @effect-diagnostics-next-line deterministicKeys:off -- Deliberately contains the old identity separator.
class Secret extends Context.Service<Secret, string>()("prefix\u0000value") {}
// @effect-diagnostics-next-line deterministicKeys:off -- Deliberately matches the suffix of Secret's key.
class Other extends Context.Service<Other, string>()("value") {}
class Bridge extends Context.Service<Bridge, string>()(
	"@graftland/graft/test/realm-identity.test/Bridge",
) {}

const secretProvider = Plugin.service(
	Secret,
	Effect.succeed("private secret"),
	{ name: "secret provider" },
)
const otherProvider = Plugin.service(Other, Effect.succeed("other value"), {
	name: "other provider",
})
const secretRealm = { isolate: [[Secret, "tenant"]] as const }
const otherRealm = { isolate: [[Other, "tenant\u0000prefix"]] as const }

describe("realm identity", () => {
	it.effect(
		"does not satisfy a required dependency with another realm and service pair",
		() =>
			Effect.gen(function* () {
				const provider = yield* Graft.plugin(
					secretProvider,
					undefined,
					secretRealm,
				)
				yield* provider.await
				const seen = yield* Ref.make(Option.none<string>())
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "required consumer",
						inject: [Other],
						apply: () =>
							Effect.flatMap(Effect.serviceOption(Secret), (value) =>
								Ref.set(seen, value),
							),
					}),
					undefined,
					otherRealm,
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
			const secret = yield* Graft.plugin(secretProvider, undefined, secretRealm)
			yield* secret.await
			const other = yield* Graft.plugin(otherProvider, undefined, otherRealm)
			yield* other.await
			const secretReader = yield* Graft.plugin(
				Plugin.make({
					name: "secret consumer",
					inject: [Secret],
					apply: () =>
						Effect.gen(function* () {
							const value = yield* Secret
							const other = yield* Effect.serviceOption(Other)
							assert.strictEqual(value, "private secret")
							assert.deepStrictEqual(other, Option.none())
						}),
				}),
				undefined,
				secretRealm,
			)
			yield* secretReader.await
			const observed = yield* Ref.make<ReadonlyArray<string>>([])
			const consumer = yield* Graft.plugin(
				Plugin.make({
					name: "other consumer",
					inject: [Other],
					apply: () =>
						Effect.gen(function* () {
							const value = yield* Other
							const leaked = yield* Effect.serviceOption(Secret)
							assert.deepStrictEqual(leaked, Option.none())
							yield* Ref.update(observed, Array.append(value))
						}),
				}),
				undefined,
				otherRealm,
			)
			yield* consumer.await
			yield* secret.dispose
			yield* TestClock.adjust("1 millis")
			const values = yield* Ref.get(observed)
			assert.deepStrictEqual(values, ["other value"])
			yield* other.dispose
			yield* reach(consumer, "Pending")
		}).pipe(run),
	)

	for (const ambient of [false, true]) {
		it.effect(
			`does not restart ${ambient ? "ambient" : "absent optional"} watchers for another pair`,
			() =>
				Effect.gen(function* () {
					const starts = yield* Ref.make(0)
					const consumer = yield* Graft.plugin(
						Plugin.make({
							name: "fallback consumer",
							inject: ambient ? [Other] : [Plugin.optional(Other)],
							apply: () =>
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
						}),
						undefined,
						otherRealm,
					)
					yield* consumer.await
					const provider = yield* Graft.plugin(
						secretProvider,
						undefined,
						secretRealm,
					)
					yield* provider.await
					yield* TestClock.adjust("1 millis")
					const afterPublication = yield* Ref.get(starts)
					assert.strictEqual(afterPublication, 1)
					const snapshot = yield* Stream.runHead(consumer.state)
					assert.strictEqual(Option.getOrThrow(snapshot)._tag, "Active")
					yield* provider.dispose
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
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "watching parent",
						inject: [Plugin.optional(Other)],
						apply: () =>
							Effect.gen(function* () {
								const child = yield* Graft.plugin(
									secretProvider,
									undefined,
									secretRealm,
								)
								yield* child.await
							}),
					}),
					undefined,
					otherRealm,
				)
				yield* parent.await
			}).pipe(run),
	)

	it.effect(
		"rechecks a rejected publication with the same structural identity",
		() =>
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0)
				const watcher = Plugin.make({
					name: "watcher",
					inject: [Plugin.optional(Other)],
					apply: () => Graft.provide(Bridge, "bridge"),
				})
				const owner = yield* Graft.plugin(watcher, undefined, otherRealm)
				yield* owner.await
				const publisher = yield* Graft.plugin(
					Plugin.make({
						name: "cyclic publisher",
						inject: [Bridge],
						apply: () =>
							Ref.update(attempts, (n) => n + 1).pipe(
								Effect.andThen(Graft.provide(Other, "published")),
							),
					}),
					undefined,
					otherRealm,
				)
				yield* reach(publisher, "Failed")
				const unrelated = yield* Graft.plugin(
					secretProvider,
					undefined,
					secretRealm,
				)
				yield* unrelated.await
				yield* unrelated.dispose
				yield* TestClock.adjust("1 millis")
				const before = yield* Ref.get(attempts)
				assert.strictEqual(before, 1)
				yield* Graft.replace([
					[
						watcher,
						Plugin.service(Bridge, Effect.succeed("bridge"), {
							name: "independent provider",
						}),
					],
				])
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "bounded retries with an optional dependency",
						inject: [Plugin.optional(Other)],
						retry,
						apply: () =>
							Effect.gen(function* () {
								const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
								// A third attempt would succeed, exposing a replenished budget without looping forever.
								if (attempt <= 2) return yield* Effect.fail("still failing")
							}),
					}),
					undefined,
					otherRealm,
				)
				yield* Effect.raceFirst(
					Deferred.await(exhausted),
					reach(fork, "Active"),
				)
				const count = yield* Ref.get(attempts)
				const snapshot = yield* Stream.runHead(fork.state)
				assert.strictEqual(count, 2)
				assert.strictEqual(Option.getOrThrow(snapshot)._tag, "Failed")
			}).pipe(run),
	)

	it.effect(
		"keeps private and root realms separate from prefix-like and empty labels",
		() =>
			Effect.gen(function* () {
				const Read = Event.make<[], string>("realm-read\u0000event")
				const room = (value: string) =>
					Plugin.make({
						name: value,
						apply: () =>
							Graft.provide(Other, value).pipe(
								Effect.andThen(Event.on(Read, () => Effect.succeed(value))),
							),
					})
				const root = yield* Graft.plugin(room("root"))
				yield* root.await
				const privateRoom = yield* Graft.plugin(room("private"), undefined, {
					isolate: [Other, Read],
				})
				yield* privateRoom.await
				for (const label of [
					"",
					`#${privateRoom.id}`,
					"@tenant",
					"tenant\u0000prefix",
				]) {
					const provider = yield* Graft.plugin(
						room(`label ${label}`),
						undefined,
						{
							isolate: [
								[Other, label],
								[Read, label],
							],
						},
					)
					yield* provider.await
					const consumer = yield* Graft.plugin(
						Plugin.make({
							name: "shared reader",
							inject: [Other],
							apply: () =>
								Effect.gen(function* () {
									const value = yield* Other
									const replies = yield* Event.parallel(Read)
									assert.strictEqual(value, `label ${label}`)
									assert.deepStrictEqual(replies, [`label ${label}`])
								}),
						}),
						undefined,
						{
							isolate: [
								[Other, label],
								[Read, label],
							],
						},
					)
					yield* consumer.await
				}
				const replies = yield* Event.parallel(Read)
				assert.deepStrictEqual(replies, ["root"])
			}).pipe(run),
	)
})
