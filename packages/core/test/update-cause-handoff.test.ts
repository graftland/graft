import { assert, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	PubSub,
	Ref,
	References,
	Schema,
	String,
} from "effect"
import { Fork, Graft, Plugin } from "../src/index.ts"
import { reach, run } from "./utils.ts"

it.effect(
	"retains completed update defects across disposal handoff positions",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* Graft.Graft
			for (const ticks of Array.range(0, 30)) {
				const marker = `completed update defect (${ticks})`
				const observed = yield* Deferred.make<void>()
				const definition = Plugin.make({
					name: "update race",
					apply: () =>
						Effect.succeed(() =>
							Effect.die(marker).pipe(
								Effect.onExit((exit) =>
									Exit.isFailure(exit) && Cause.hasDies(exit.cause)
										? Deferred.succeed(observed, undefined)
										: Effect.void,
								),
							),
						),
				})
				const fork = yield* Graft.plugin(definition).pipe(
					Effect.provideService(References.MaxOpsBeforeYield, 4),
				)
				yield* fork.await
				const updating = yield* Effect.forkScoped(fork.update(undefined))
				yield* Deferred.await(observed)
				for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow
				const disposed = yield* Effect.exit(fork.dispose)
				yield* Fiber.join(updating)
				const subscription = yield* PubSub.subscribe(runtime.logs)
				const logs = yield* PubSub.takeAll(subscription)
				assert.isTrue(
					(Exit.isFailure(disposed) &&
						String.includes(marker)(Cause.pretty(disposed.cause))) ||
						Array.some(logs, (entry) =>
							String.includes(marker)(Cause.pretty(entry.cause)),
						),
					`The observed defect must not disappear: ${marker}`,
				)
			}
		}).pipe(run),
)

for (const phase of ["decode", "update"] as const) {
	it.effect(
		`shares a completed ${phase} defect with disposal during finalization`,
		() =>
			Effect.gen(function* () {
				const observed = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const stopping = yield* Deferred.make<void>()
				const marker = `${phase} handoff defect`
				const failing = Effect.die(marker).pipe(
					Effect.onExit(() =>
						Deferred.succeed(observed, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					),
				)
				const base = Plugin.make({
					name: "update finalization",
					config: Schema.Finite,
					apply: () =>
						Effect.succeed(() =>
							phase === "update" ? failing : Effect.succeed(true),
						),
				})
				const fork = yield* Graft.plugin(
					{
						...base,
						decode: (input: number) =>
							phase === "decode" && input === 1
								? failing
								: Effect.succeed(input),
					},
					0,
					{
						intercept: [
							{
								apply: (effect) =>
									Effect.raceFirst(
										effect,
										Effect.never.pipe(
											Effect.onInterrupt(() =>
												Deferred.succeed(stopping, undefined),
											),
										),
									),
							},
						],
					},
				)
				yield* fork.await
				const updating = yield* Effect.forkScoped(fork.update(1))
				yield* Deferred.await(observed)
				const disposing = yield* Effect.forkScoped(Effect.exit(fork.dispose))
				yield* Deferred.await(stopping)
				yield* Deferred.succeed(release, undefined)
				const result = yield* Fiber.join(disposing)
				yield* Fiber.join(updating)
				const repeated = yield* Effect.exit(fork.dispose)
				assert.deepStrictEqual(result, repeated)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) {
					const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
					assert.isTrue(Schema.is(Fork.CleanupError)(error))
					assert.include(Cause.pretty(error.cause), marker)
				}
			}).pipe(run),
	)
}

it.effect(
	"keeps resources acquired by an update until activation teardown",
	() =>
		Effect.gen(function* () {
			const released = yield* Ref.make(false)
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "update resource ownership",
					config: Schema.Finite,
					apply: () =>
						Effect.succeed(() =>
							Effect.acquireRelease(Effect.void, () =>
								Ref.set(released, true),
							).pipe(Effect.as(true)),
						),
				}),
				0,
			)
			yield* fork.await
			yield* fork.update(1)
			const duringActivation = yield* Ref.get(released)
			assert.isFalse(duringActivation)
			yield* fork.dispose
			const afterDisposal = yield* Ref.get(released)
			assert.isTrue(afterDisposal)
		}).pipe(run),
)

it.effect(
	"observes an update defect before restarting without replaying it on later disposal",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* Graft.Graft
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "update recovery",
					config: Schema.Finite,
					apply: () =>
						Effect.succeed(() => Effect.die("recoverable update defect")),
				}),
				0,
			)
			yield* fork.await
			yield* fork.update(1)
			yield* reach(fork, "Active")
			const result = yield* Effect.exit(fork.dispose)
			assert.isTrue(Exit.isSuccess(result))
			const subscription = yield* PubSub.subscribe(runtime.logs)
			const logs = yield* PubSub.takeAll(subscription)
			assert.isTrue(
				Array.some(logs, (entry) =>
					String.includes("recoverable update defect")(
						Cause.pretty(entry.cause),
					),
				),
			)
		}).pipe(run),
)

it.effect(
	"combines worker failure with the cleanup of the update it cancels",
	() =>
		Effect.gen(function* () {
			const updating = yield* Deferred.make<void>()
			const failWorker = yield* Deferred.make<void>()
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "worker cancels update",
					config: Schema.Finite,
					apply: () =>
						Effect.gen(function* () {
							yield* Plugin.fork(
								Deferred.await(failWorker).pipe(
									Effect.andThen(Effect.fail("worker failure")),
								),
							)
							return () =>
								Deferred.succeed(updating, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(Effect.die("cancelled update cleanup")),
								)
						}),
				}),
				0,
			)
			yield* fork.await
			const changed = yield* Effect.forkScoped(fork.update(1))
			yield* Deferred.await(updating)
			yield* Deferred.succeed(failWorker, undefined)
			yield* Fiber.join(changed)
			yield* reach(fork, "Failed")
			const result = yield* Effect.exit(fork.await)
			assert.isTrue(Exit.isFailure(result))
			if (Exit.isFailure(result)) {
				assert.include(Cause.pretty(result.cause), "worker failure")
				assert.include(Cause.pretty(result.cause), "cancelled update cleanup")
			}
			yield* fork.dispose
		}).pipe(run),
)
