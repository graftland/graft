import {
	Array,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	HashMap,
	Option,
	Ref,
	References,
	Scope,
	TxRef,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { expectTypeOf } from "vitest"

import { Event } from "../src/index.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import * as Release from "../src/Release.ts"
import { run } from "./utils.ts"

const Listener = Context.Reference<string>("event-claim/Listener", {
	defaultValue: () => "live",
})

const liveOnly = Event.filtered((owner) => {
	assert.strictEqual(
		Context.get(owner, Listener),
		"live",
		"Dispatch filters must not observe an already consumed once registration",
	)
	return true
})

const modes = ["emit", "parallel", "bail", "waterfall"] as const

describe("consumed once visibility", () => {
	for (const mode of modes) {
		it.effect(
			`excludes a running once handler from a concurrent ${mode} filter`,
			() =>
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>()
					const finish = yield* Deferred.make<void>()
					const calls = yield* Ref.make(0)
					const event = Event.make<[], Option.Option<string>>(
						`filtered-${mode}`,
					)
					const middleware = Event.middleware<string, string>(
						`filtered-${mode}`,
					)
					const blocked = Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(finish)),
					)
					if (mode === "waterfall") {
						yield* Event.once(middleware, () =>
							blocked.pipe(Effect.as("once")),
						).pipe(Effect.provideService(Listener, "consumed"))
						yield* Event.on(middleware, (input, next) =>
							Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(next(input))),
						)
					} else {
						yield* Event.once(event, () =>
							blocked.pipe(Effect.as(Option.some("once"))),
						).pipe(Effect.provideService(Listener, "consumed"))
						yield* Event.on(event, () =>
							Ref.update(calls, (n) => n + 1).pipe(
								Effect.as(Option.some("live")),
							),
						)
					}
					const dispatch =
						mode === "waterfall"
							? Event.waterfall(middleware, "input", Effect.succeed).pipe(
									Effect.asVoid,
								)
							: mode === "emit"
								? Event.emit(event)
								: mode === "parallel"
									? Event.parallel(event).pipe(Effect.asVoid)
									: Event.bail(event).pipe(Effect.asVoid)
					const first = yield* Effect.forkScoped(dispatch)
					yield* Deferred.await(entered)
					const second = yield* Effect.exit(dispatch.pipe(liveOnly))
					yield* Deferred.succeed(finish, undefined)
					yield* Fiber.join(first)
					yield* second
					const count = yield* Ref.get(calls)
					assert.isAbove(count, 0)
				}).pipe(run),
		)
	}

	it.effect(
		"excludes a once handler from its own reentrant dispatch filter",
		() =>
			Effect.gen(function* () {
				const event = Event.make<[]>("reentrant-filter")
				yield* Event.once(event, () => Event.emit(event).pipe(liveOnly)).pipe(
					Effect.provideService(Listener, "consumed"),
				)
				yield* Event.on(event, () => Effect.void)
				yield* Event.emit(event)
			}).pipe(run),
	)

	it.effect(
		"removes a once entry before its body while retaining fiber ownership",
		() =>
			Effect.gen(function* () {
				const event = Event.make<[]>("claim-map-visibility")
				const { runtime } = yield* RuntimeContext
				yield* Event.once(event, () =>
					Effect.map(TxRef.get(runtime.events), (events) =>
						assert.isFalse(
							HashMap.has(events, event.key),
							"The once entry must be removed before execution",
						),
					),
				)
				const before = yield* TxRef.get(runtime.events)
				const handler = Option.getOrThrow(HashMap.get(before, event.key))[0]!
				const exit = yield* Effect.exit(Event.emit(event))
				const owned = yield* FiberSet.size(handler.fibers)
				assert.strictEqual(owned, 0)
				yield* exit
			}).pipe(run),
	)
})

describe("fast path lifecycle controls", () => {
	it("keeps scope closure free of typed errors and service requirements", () => {
		expectTypeOf<
			Effect.Error<ReturnType<typeof Release.close>>
		>().toEqualTypeOf<never>()
		expectTypeOf<
			Effect.Services<ReturnType<typeof Release.close>>
		>().toEqualTypeOf<never>()
	})

	for (const registration of ["on", "once"] as const) {
		it.effect(
			`cleans up ${registration} dispatch at scheduler interruption boundaries`,
			() =>
				Effect.gen(function* () {
					const { runtime } = yield* RuntimeContext
					for (const ticks of Array.range(0, 80)) {
						const parent = yield* Effect.scope
						const owner = yield* Scope.fork(parent)
						const event = Event.make<[]>(`cancel-${registration}-${ticks}`)
						const running = yield* Ref.make(false)
						yield* Event[registration](event, () =>
							Effect.acquireRelease(Ref.set(running, true), () =>
								Ref.set(running, false),
							).pipe(Effect.andThen(Effect.never)),
						).pipe(Scope.provide(owner))
						const before = yield* TxRef.get(runtime.events)
						const handler = Option.getOrThrow(
							HashMap.get(before, event.key),
						)[0]!
						const dispatch = yield* Event.emit(event).pipe(
							Effect.provideService(References.MaxOpsBeforeYield, 4),
							Effect.forkScoped,
						)
						for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow
						yield* Fiber.interrupt(dispatch)
						const stillRunning = yield* Ref.get(running)
						assert.isFalse(stillRunning)
						const owned = yield* FiberSet.size(handler.fibers)
						assert.strictEqual(owned, 0)
						yield* Scope.close(owner, Exit.void)
						const after = yield* TxRef.get(runtime.events)
						assert.isFalse(HashMap.has(after, event.key))
					}
				}).pipe(run),
		)
	}
})

describe("registration identity and filtering controls", () => {
	it.effect(
		"keeps a re-registration of the same callback independent of a running once claim",
		() =>
			Effect.gen(function* () {
				const event = Event.make<[], string>("same-callback")
				const calls = yield* Ref.make(0)
				const entered = yield* Deferred.make<void>()
				const finish = yield* Deferred.make<void>()
				const handler = () =>
					Effect.gen(function* () {
						const call = yield* Ref.getAndUpdate(calls, (n) => n + 1)
						if (call === 0) {
							yield* Deferred.succeed(entered, undefined)
							yield* Deferred.await(finish)
						}
						return `call ${call}`
					})
				yield* Event.once(event, handler)
				const first = yield* Effect.forkScoped(Event.parallel(event))
				yield* Deferred.await(entered)
				yield* Event.once(event, handler)
				yield* Deferred.succeed(finish, undefined)
				const original = yield* Fiber.join(first)
				const registeredAgain = yield* Event.parallel(event)
				const exhausted = yield* Event.parallel(event)
				assert.deepStrictEqual(original, ["call 0"])
				assert.deepStrictEqual(registeredAgain, ["call 1"])
				assert.deepStrictEqual(exhausted, [])
			}).pipe(run),
	)

	it.effect(
		"does not consume filtered once handlers and preserves global prepend order",
		() =>
			Effect.gen(function* () {
				const event = Event.make<[], string>("once-filter-control")
				yield* Event.once(event, () => Effect.succeed("local"))
				yield* Event.once(event, () => Effect.succeed("global"), {
					global: true,
				})
				yield* Event.once(event, () => Effect.succeed("prepended"), {
					global: true,
					prepend: true,
				})
				const filtered = yield* Event.parallel(event).pipe(
					Event.filtered(() => false),
				)
				const remaining = yield* Event.parallel(event)
				assert.deepStrictEqual(filtered, ["prepended", "global"])
				assert.deepStrictEqual(remaining, ["local"])
			}).pipe(run),
	)
})
