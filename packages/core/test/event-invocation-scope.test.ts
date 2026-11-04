import { assert, describe, it } from "@effect/vitest"
import {
	Array,
	Option,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
} from "effect"
import { Event, Graft, Plugin } from "../src/index.ts"
import { makeJournal, run } from "./utils.ts"

const resource = (alive: Ref.Ref<boolean>) =>
	Effect.acquireRelease(Ref.set(alive, true), () => Ref.set(alive, false))

describe("event invocation scopes", () => {
	for (const registration of ["on", "once"] as const) {
		it.effect(
			`keeps ${registration} resources alive through owner cancellation cleanup`,
			() =>
				Effect.gen(function* () {
					const event = Event.make<[]>(`invocation-owner-${registration}`)
					const entered = yield* Deferred.make<void>()
					const alive = yield* Ref.make(false)
					const observed = yield* Deferred.make<boolean>()
					const owner = yield* Graft.plugin(
						Plugin.make({
							name: "handler owner",
							apply: () =>
								Event[registration](event, () =>
									Effect.gen(function* () {
										yield* resource(alive)
										yield* Deferred.succeed(entered, undefined)
										return yield* Effect.never.pipe(
											Effect.onInterrupt(() =>
												Effect.flatMap(Ref.get(alive), (value) =>
													Deferred.succeed(observed, value),
												),
											),
										)
									}),
								),
						}),
					)
					yield* owner.await
					const dispatch = yield* Effect.forkScoped(Event.emit(event))
					yield* Deferred.await(entered)
					yield* owner.dispose
					yield* Fiber.join(dispatch)
					const duringCleanup = yield* Deferred.await(observed)
					const after = yield* Ref.get(alive)
					assert.isTrue(duringCleanup)
					assert.isFalse(after)
				}).pipe(run),
		)

		it.effect(
			`releases ${registration} invocation resources before dispatch returns`,
			() =>
				Effect.gen(function* () {
					const event = Event.make<[]>(`invocation-complete-${registration}`)
					const alive = yield* Ref.make(false)
					const registrationScope = yield* Effect.scope
					yield* Event[registration](event, () =>
						Effect.gen(function* () {
							const invocationScope = yield* Effect.scope
							assert.notStrictEqual(invocationScope, registrationScope)
							yield* resource(alive)
						}),
					)
					yield* Event.emit(event)
					const after = yield* Ref.get(alive)
					assert.isFalse(after)
				}).pipe(run),
		)
	}

	it.effect("keeps concurrent invocation resources independent", () =>
		Effect.gen(function* () {
			const event = Event.make<
				[Ref.Ref<boolean>, Deferred.Deferred<void>, Deferred.Deferred<void>]
			>("concurrent-invocations")
			const firstAlive = yield* Ref.make(false)
			const secondAlive = yield* Ref.make(false)
			const firstStarted = yield* Deferred.make<void>()
			const secondStarted = yield* Deferred.make<void>()
			const finishFirst = yield* Deferred.make<void>()
			const finishSecond = yield* Deferred.make<void>()
			yield* Event.on(event, (alive, started, finish) =>
				Effect.gen(function* () {
					yield* resource(alive)
					yield* Deferred.succeed(started, undefined)
					yield* Deferred.await(finish)
				}),
			)
			const first = yield* Effect.forkScoped(
				Event.emit(event, firstAlive, firstStarted, finishFirst),
			)
			const second = yield* Effect.forkScoped(
				Event.emit(event, secondAlive, secondStarted, finishSecond),
			)
			yield* Deferred.await(firstStarted)
			yield* Deferred.await(secondStarted)
			yield* Deferred.succeed(finishFirst, undefined)
			yield* Fiber.join(first)
			const firstClosed = !(yield* Ref.get(firstAlive))
			const secondStillOpen = yield* Ref.get(secondAlive)
			yield* Deferred.succeed(finishSecond, undefined)
			yield* Fiber.join(second)
			const secondClosed = !(yield* Ref.get(secondAlive))
			assert.isTrue(firstClosed)
			assert.isTrue(secondStillOpen)
			assert.isTrue(secondClosed)
		}).pipe(run),
	)

	it.effect(
		"nests middleware invocation lifetimes around next while last owns its resources",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<string, string>(
					"nested-invocation-scopes",
				)
				const journal = yield* makeJournal
				for (const name of ["outer", "inner"]) {
					yield* Event.on(event, (input, next) =>
						Effect.gen(function* () {
							yield* Effect.acquireRelease(
								journal.record(`${name} acquired`),
								() => journal.record(`${name} released`),
							)
							const output = yield* next(input)
							yield* journal.record(`${name} resumed`)
							return output
						}),
					)
				}
				yield* Event.waterfall(event, "input", (input) =>
					Effect.gen(function* () {
						yield* Effect.acquireRelease(journal.record("last acquired"), () =>
							journal.record("last released"),
						)
						return input
					}),
				)
				yield* journal.expect([
					"outer acquired",
					"inner acquired",
					"last acquired",
					"last released",
					"inner resumed",
					"inner released",
					"outer resumed",
					"outer released",
				])
			}).pipe(run),
	)

	it.effect(
		"releases last resources without requiring middleware or a dispatcher scope",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<void, void>("last-invocation")
				const alive = yield* Ref.make(false)
				const dispatch: Effect.Effect<void, never, Graft.Graft> =
					Event.waterfall(event, undefined, () => resource(alive))
				yield* dispatch
				const after = yield* Ref.get(alive)
				assert.isFalse(after)
			}).pipe(run),
	)

	it.effect(
		"keeps last resources alive through cancellation by a middleware owner",
		() =>
			Effect.gen(function* () {
				const event = Event.middleware<void, void>("last-cancellation")
				const started = yield* Deferred.make<void>()
				const observed = yield* Deferred.make<boolean>()
				const alive = yield* Ref.make(false)
				const owner = yield* Graft.plugin(
					Plugin.make({
						name: "middleware owner",
						apply: () => Event.on(event, (input, next) => next(input)),
					}),
				)
				yield* owner.await
				const dispatch = yield* Effect.forkScoped(
					Event.waterfall(event, undefined, () =>
						Effect.gen(function* () {
							yield* resource(alive)
							yield* Deferred.succeed(started, undefined)
							return yield* Effect.never.pipe(
								Effect.onInterrupt(() =>
									Effect.flatMap(Ref.get(alive), (value) =>
										Deferred.succeed(observed, value),
									),
								),
							)
						}),
					),
				)
				yield* Deferred.await(started)
				yield* owner.dispose
				const exit = yield* Fiber.await(dispatch)
				const duringCleanup = yield* Deferred.await(observed)
				const after = yield* Ref.get(alive)
				assert.isTrue(Exit.isFailure(exit))
				assert.isTrue(duringCleanup)
				assert.isFalse(after)
			}).pipe(run),
	)

	for (const callback of ["handler", "last"] as const) {
		it.effect(
			`preserves ${callback} execution and scope cleanup failures in dispatch`,
			() =>
				Effect.gen(function* () {
					const action = Effect.addFinalizer(() =>
						Effect.die("invocation cleanup defect"),
					).pipe(Effect.andThen(Effect.fail("invocation failure")))
					const event = Event.middleware<void, void, string>(
						`invocation-failure-${callback}`,
					)
					if (callback === "handler") yield* Event.on(event, () => action)
					const exit = yield* Effect.exit(
						Event.waterfall(event, undefined, () =>
							callback === "last" ? action : Effect.void,
						),
					)
					assert.isTrue(Exit.isFailure(exit))
					if (Exit.isFailure(exit)) {
						assert.include(Cause.pretty(exit.cause), "invocation failure")
						assert.include(
							Cause.pretty(exit.cause),
							"invocation cleanup defect",
						)
					}
				}).pipe(run),
		)
	}
})

for (const mode of ["emit", "parallel", "bail", "waterfall"]) {
	it.effect(
		`preserves handler cleanup interruption when cancelling ${mode}`,
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<number>()
				const completed = yield* Ref.make(false)
				const handler = Effect.addFinalizer(() =>
					Effect.interrupt.pipe(Effect.andThen(Ref.set(completed, true))),
				).pipe(
					Effect.andThen(
						Effect.withFiber((self) => Deferred.succeed(entered, self.id)),
					),
					Effect.andThen(Effect.never),
				)
				const event = Event.make<[], Option.Option<void>>("cancelled-handler")
				const middleware = Event.middleware<void, void>("cancelled-middleware")
				yield* Event.on(event, () => handler)
				yield* Event.on(middleware, () => handler)
				const dispatch = yield* Effect.forkScoped(
					mode === "waterfall"
						? Event.waterfall(middleware, undefined, () => Effect.void)
						: mode === "emit"
							? Event.emit(event)
							: mode === "parallel"
								? Event.parallel(event)
								: Event.bail(event),
				)
				const id = yield* Deferred.await(entered)
				yield* Fiber.interrupt(dispatch)
				const exit = yield* Fiber.await(dispatch)
				assert(Exit.isFailure(exit))
				assert.isTrue(
					Array.some(
						exit.cause.reasons,
						(reason) => reason._tag === "Interrupt" && reason.fiberId === id,
					),
				)
				const released = yield* Ref.get(completed)
				assert.isFalse(released)
			}).pipe(run),
	)
}
