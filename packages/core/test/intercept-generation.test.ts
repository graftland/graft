import { assert, it } from "@effect/vitest"
import {
	Deferred,
	Effect,
	Fiber,
	HashMap,
	Option,
	Ref,
	Schema,
	Stream,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { TestClock } from "effect/testing"
import { Graft, Plugin } from "../src/index.ts"
import { reach, run } from "./utils.ts"

it.effect(
	"does not rerun a failed intercept because of an already accepted update",
	() =>
		Effect.gen(function* () {
			const fail = yield* Deferred.make<void>()
			const calls = yield* Ref.make(0)
			const intercept: Graft.Intercept = {
				apply: (effect) =>
					Ref.update(calls, (n) => n + 1).pipe(
						Effect.andThen(
							Effect.raceFirst(
								effect,
								Deferred.await(fail).pipe(
									Effect.andThen(Effect.die("intercept failure")),
								),
							),
						),
					),
			}
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "updated plugin",
					config: Schema.String,
					apply: () => Effect.succeed(() => Effect.succeed(true)),
				}),
				"initial",
				{ intercept: [intercept] },
			)
			yield* fork.await
			yield* fork.update("accepted")
			yield* Deferred.succeed(fail, undefined)
			yield* reach(fork, "Failed")
			// Wait for the supervisor to settle without relying on the first Failed emission.
			yield* TestClock.adjust("1 millis")
			const actual = yield* Ref.get(calls)
			yield* fork.dispose
			assert.strictEqual(actual, 1)
		}).pipe(run),
)

it.effect(
	"does not consume a request that arrives while intercept failure is cleaning up",
	() =>
		Effect.gen(function* () {
			const fail = yield* Deferred.make<void>()
			const cleaning = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const calls = yield* Ref.make(0)
			const intercept: Graft.Intercept = {
				apply: (effect) =>
					Effect.flatMap(
						Ref.updateAndGet(calls, (n) => n + 1),
						(call) =>
							call === 1
								? Effect.raceFirst(
										effect,
										Deferred.await(fail).pipe(
											Effect.andThen(Effect.die("wrapper failed")),
										),
									)
								: effect,
					),
			}
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "intercept recovery",
					config: Schema.String,
					apply: (input) =>
						Effect.gen(function* () {
							if (input === "initial")
								yield* Effect.addFinalizer(() =>
									Deferred.succeed(cleaning, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
									),
								)
							return () => Effect.succeed(true)
						}),
				}),
				"initial",
				{ intercept: [intercept] },
			)
			yield* fork.await
			yield* fork.update("accepted")
			yield* Deferred.succeed(fail, undefined)
			yield* Deferred.await(cleaning)
			const updating = yield* Effect.forkScoped(fork.update("unprocessed"))
			const { runtime } = yield* Graft.Graft
			yield* Effect.tx(
				Effect.gen(function* () {
					const entries = yield* TxSubscriptionRef.get(runtime.forks)
					const entry = Option.getOrThrow(HashMap.get(entries, fork.id))
					const spec = yield* TxRef.get(entry.spec)
					if (spec.input !== "unprocessed") return yield* Effect.txRetry
				}),
			)
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(updating)
			yield* reach(fork, "Active")
			const count = yield* Ref.get(calls)
			const snapshot = yield* Stream.runHead(Graft.forks)
			assert.strictEqual(count, 2)
			assert.strictEqual(Option.getOrThrow(snapshot)[0]?.input, "unprocessed")
		}).pipe(run),
)

it.effect("attributes an intercept failure to an in-progress update", () =>
	Effect.gen(function* () {
		const updating = yield* Deferred.make<void>()
		const calls = yield* Ref.make(0)
		const intercept: Graft.Intercept = {
			apply: (effect) =>
				Ref.update(calls, (n) => n + 1).pipe(
					Effect.andThen(
						Effect.raceFirst(
							effect,
							Deferred.await(updating).pipe(
								Effect.andThen(Effect.die("update wrapper failed")),
							),
						),
					),
				),
		}
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: "interrupted update",
				config: Schema.String,
				apply: () =>
					Effect.succeed(() =>
						Deferred.succeed(updating, undefined).pipe(
							Effect.andThen(Effect.never),
						),
					),
			}),
			"initial",
			{ intercept: [intercept] },
		)
		yield* fork.await
		yield* fork.update("processing")
		yield* reach(fork, "Failed")
		yield* TestClock.adjust("1 millis")
		const count = yield* Ref.get(calls)
		const snapshot = yield* Stream.runHead(Graft.forks)
		assert.strictEqual(count, 1)
		assert.strictEqual(Option.getOrThrow(snapshot)[0]?.input, "processing")
	}).pipe(run),
)
