import { assert, describe, it } from "@effect/vitest"
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	HashMap,
	Option,
	Ref,
	Scope,
	TxRef,
} from "effect"
import { Event, Graft } from "../src/index.ts"
import { makeJournal, run } from "./utils.ts"

const ownedScope = Effect.acquireRelease(Scope.make(), (scope) =>
	Scope.close(scope, Exit.void),
)

describe("immediate event invocation", () => {
	it.effect("owns the invocation before running the handler", () =>
		Effect.gen(function* () {
			const event = Event.make<[]>("immediate-ownership")
			const { runtime } = yield* Graft.Graft
			const size = yield* Ref.make(0)
			yield* Event.on(event, () =>
				Effect.gen(function* () {
					const events = yield* TxRef.get(runtime.events)
					const handlers = Option.getOrThrow(HashMap.get(events, event.key))
					const handler = handlers[0]!
					const owned = yield* FiberSet.size(handler.fibers)
					yield* Ref.set(size, owned)
				}),
			)
			yield* Event.emit(event)
			const observed = yield* Ref.get(size)
			assert.strictEqual(observed, 1)
		}).pipe(run),
	)

	for (const registration of ["on", "once"] as const) {
		it.effect(
			`interrupts ${registration} invocations that synchronously start closing their owner`,
			() =>
				Effect.gen(function* () {
					const event = Event.make<[]>(`immediate-close-${registration}`)
					const owner = yield* ownedScope
					const controller = yield* Effect.scope
					const closed = yield* Deferred.make<void>()
					const journal = yield* makeJournal
					yield* Event[registration](event, () =>
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => journal.record("cleaned"))
							yield* Effect.forkIn(
								Scope.close(owner, Exit.void).pipe(
									Effect.andThen(Deferred.succeed(closed, undefined)),
								),
								controller,
								{ startImmediately: true },
							)
							yield* journal.record("continued after owner cancellation")
						}),
					).pipe(Scope.provide(owner))
					yield* Event.emit(event)
					yield* Deferred.await(closed)
					yield* journal.expect(["cleaned"])
				}).pipe(run),
		)

		it.effect(
			`preserves cleanup failure when ${registration} invocations cancel their dispatcher before suspending`,
			() =>
				Effect.gen(function* () {
					const event = Event.make<[Fiber.Fiber<unknown, unknown>]>(
						`immediate-dispatch-cancellation-${registration}`,
					)
					const cleaned = yield* Ref.make(false)
					yield* Event[registration](event, (caller) =>
						Effect.withFiber((self) =>
							Effect.sync(() => caller.interruptUnsafe(self.id)),
						).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(
								Ref.set(cleaned, true).pipe(
									Effect.andThen(Effect.die("immediate cancellation cleanup")),
								),
							),
						),
					)
					const dispatch = yield* Effect.forkScoped(
						Effect.withFiber((caller) => Event.emit(event, caller)),
					)
					const exit = yield* Fiber.await(dispatch)
					const finished = yield* Ref.get(cleaned)
					assert.isTrue(finished)
					assert.isTrue(Exit.isFailure(exit))
					if (Exit.isFailure(exit)) {
						assert.isTrue(Cause.hasInterrupts(exit.cause))
						assert.include(
							Cause.pretty(exit.cause),
							"immediate cancellation cleanup",
						)
					}
				}).pipe(run),
		)
	}

	it.effect(
		"keeps reentrant owner cancellation distinct while cleanup suspends",
		() =>
			Effect.gen(function* () {
				const event = Event.make<[]>("immediate-close-cleanup")
				const owner = yield* ownedScope
				const controller = yield* Effect.scope
				const cleaning = yield* Deferred.make<void>()
				const finish = yield* Deferred.make<void>()
				const closed = yield* Deferred.make<void>()
				yield* Event.on(event, () =>
					Effect.gen(function* () {
						yield* Effect.addFinalizer(() =>
							Deferred.succeed(cleaning, undefined).pipe(
								Effect.andThen(Deferred.await(finish)),
							),
						)
						yield* Effect.forkIn(
							Scope.close(owner, Exit.void).pipe(
								Effect.andThen(Deferred.succeed(closed, undefined)),
							),
							controller,
							{ startImmediately: true },
						)
					}),
				).pipe(Scope.provide(owner))
				const dispatch = yield* Effect.forkScoped(Event.emit(event))
				yield* Deferred.await(cleaning)
				yield* Deferred.succeed(finish, undefined)
				yield* Fiber.join(dispatch)
				yield* Deferred.await(closed)
			}).pipe(run),
	)

	it.effect(
		"keeps synchronous recursive dispatch and once claims ordered",
		() =>
			Effect.gen(function* () {
				const event = Event.make<[number]>("immediate-recursive")
				const journal = yield* makeJournal
				yield* Event.once(event, (depth) =>
					journal
						.record(`once ${depth}`)
						.pipe(Effect.andThen(Event.emit(event, depth + 1))),
				)
				yield* Event.on(event, (depth) =>
					journal
						.record(`on ${depth}`)
						.pipe(
							Effect.andThen(
								depth < 2 ? Event.emit(event, depth + 1) : Effect.void,
							),
						),
				)
				yield* Event.emit(event, 0)
				yield* journal.expect([
					"once 0",
					"on 1",
					"on 2",
					"on 0",
					"on 1",
					"on 2",
				])
			}).pipe(run),
	)

	it.effect(
		"retains self interruption when owner cancellation starts during cleanup",
		() =>
			Effect.gen(function* () {
				const event = Event.make<[]>("immediate-self-interruption")
				const owner = yield* ownedScope
				const { runtime } = yield* Graft.Graft
				const cleaning = yield* Deferred.make<void>()
				const finish = yield* Deferred.make<void>()
				yield* Event.on(event, () =>
					Effect.interrupt.pipe(
						Effect.ensuring(
							Deferred.succeed(cleaning, undefined).pipe(
								Effect.andThen(Deferred.await(finish)),
							),
						),
					),
				).pipe(Scope.provide(owner))
				const events = yield* TxRef.get(runtime.events)
				const handlers = Option.getOrThrow(HashMap.get(events, event.key))
				const handler = handlers[0]!
				const dispatch = yield* Effect.forkScoped(Event.emit(event))
				yield* Deferred.await(cleaning)
				const closing = yield* Effect.forkScoped(Scope.close(owner, Exit.void))
				yield* Deferred.await(handler.closing)
				yield* Deferred.succeed(finish, undefined)
				yield* Fiber.join(closing)
				const exit = yield* Fiber.await(dispatch)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
			}).pipe(run),
	)
})
