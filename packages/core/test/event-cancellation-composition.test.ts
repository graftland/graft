import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Ref,
	Schedule,
	Scope,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { run } from "./utils.ts"

const register = Effect.fn("register")(function* (
	mode: string,
	name: string,
	handler: Effect.Effect<void, never, Graft.Graft>,
	registration: "on" | "once" = "on",
) {
	const graft = yield* RuntimeContext
	if (mode === "waterfall") {
		const event = Event.middleware<void, void>(name)
		yield* Event[registration](event, () => handler)
		return {
			dispatch: Event.waterfall(event, undefined, () => Effect.void).pipe(
				Effect.provideService(Graft.Graft, graft),
			),
		}
	}
	const event = Event.make<[], Option.Option<void>>(name)
	yield* Event[registration](event, () =>
		handler.pipe(Effect.as(Option.none<void>())),
	)
	return {
		dispatch: (mode === "emit"
			? Event.emit(event)
			: mode === "parallel"
				? Event.parallel(event)
				: Event.bail(event)
		).pipe(Effect.asVoid, Effect.provideService(Graft.Graft, graft)),
	}
})

for (const mode of ["emit", "parallel", "bail", "waterfall"]) {
	for (const phase of [
		"apply",
		"update",
		"retry initialization",
		"retry step",
		"intercept",
	]) {
		it.effect(`disposes normally while ${phase} waits for ${mode}`, () =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const { dispatch } = yield* register(
					mode,
					"waiting event",
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				)
				const retry = dispatch.pipe(Effect.andThen(Effect.never))
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "event cancellation",
						...(phase === "retry initialization"
							? { retry: Schedule.fromStep(retry) }
							: phase === "retry step"
								? { retry: Schedule.fromStep(Effect.succeed(() => retry)) }
								: {}),
						apply: () =>
							phase === "apply"
								? dispatch
								: phase === "update"
									? Effect.succeed(() => dispatch.pipe(Effect.as(true)))
									: phase === "intercept"
										? Effect.void
										: Effect.fail("startup failure"),
					}),
					undefined,
					phase === "intercept"
						? {
								intercept: [
									{ apply: (effect) => Effect.raceFirst(effect, retry) },
								],
							}
						: {},
				)
				if (phase === "update") {
					yield* fork.await
					yield* fork.update(undefined).pipe(Effect.forkScoped)
				}
				yield* Deferred.await(entered)
				yield* fork.dispose
			}).pipe(run),
		)
	}

	it.effect(`automatically closes apply while it waits for ${mode}`, () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const { dispatch } = yield* register(
				mode,
				"automatic event cancellation",
				Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
			)
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* Graft.plugin(
						Plugin.make({
							name: "automatically closed dispatcher",
							apply: () => dispatch,
						}),
					)
					yield* Deferred.await(entered)
				}),
			)
		}).pipe(run),
	)

	it.effect(`skips a withdrawn owner while its handler nests ${mode}`, () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const { dispatch: inner } = yield* register(
				mode,
				"inner event",
				Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
			)
			const owner = yield* Effect.acquireRelease(Scope.make(), Scope.close)
			const { dispatch: outer } = yield* register(
				mode,
				"outer event",
				inner,
			).pipe(Scope.provide(owner))
			const dispatch = yield* outer.pipe(Effect.forkScoped)
			yield* Deferred.await(entered)
			yield* Scope.close(owner, Exit.void)
			yield* Fiber.join(dispatch)
		}).pipe(run),
	)
}

const registrations: ReadonlyArray<"on" | "once"> = ["on", "once"]
for (const mode of ["emit", "parallel", "bail", "waterfall"]) {
	for (const registration of registrations) {
		for (const first of ["owner", "dispatcher"]) {
			it.effect(
				`completes ${registration} ${mode} cleanup when ${first} closes first`,
				() =>
					Effect.gen(function* () {
						const entered = yield* Deferred.make<void>()
						const cleaning = yield* Deferred.make<void>()
						const release = yield* Deferred.make<void>()
						const released = yield* Ref.make(false)
						const owner = yield* Effect.acquireRelease(
							Scope.make(),
							Scope.close,
						)
						const { dispatch } = yield* register(
							mode,
							"concurrent cancellation",
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(
									Deferred.succeed(cleaning, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
										Effect.andThen(Ref.set(released, true)),
									),
								),
							),
							registration,
						).pipe(Scope.provide(owner))
						const caller = yield* Graft.plugin(
							Plugin.make({
								name: "concurrently cancelled dispatcher",
								apply: () => dispatch,
							}),
						)
						yield* Deferred.await(entered)
						const closeOwner = Scope.close(owner, Exit.void)
						const closeCaller = caller.dispose
						const initial = yield* Effect.forkScoped(
							Effect.exit(first === "owner" ? closeOwner : closeCaller),
						)
						yield* Deferred.await(cleaning)
						const concurrent = yield* Effect.forkScoped(
							Effect.exit(first === "owner" ? closeCaller : closeOwner),
						)
						yield* Effect.yieldNow
						yield* Effect.yieldNow
						yield* Deferred.succeed(release, undefined)
						const initialExit = yield* Fiber.join(initial)
						const concurrentExit = yield* Fiber.join(concurrent)
						assert.deepStrictEqual(initialExit, Exit.void)
						assert.deepStrictEqual(concurrentExit, Exit.void)
						const completed = yield* Ref.get(released)
						assert.isTrue(completed)
					}).pipe(run),
			)
		}
	}
}
