import {
	Array,
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	PubSub,
	Scope,
	String,
} from "effect"

import {
	audit,
	eventScenario,
	snapshot,
	type Case,
	type Fixture,
} from "./model"

class Counter extends Context.Service<
	Counter,
	{ readonly call: (input: number) => number }
>()("@graftland/benchmarks/baseline/Counter") {}

export const make = Effect.fnUntraced(function* (
	spec: Case,
): Effect.fn.Return<Fixture> {
	const state = audit()
	const root = yield* Scope.make()
	const resource = Effect.gen(function* () {
		state.activations++
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				state.finalizers++
			}),
		)
	})
	const call = (input: number) => {
		state.calls++
		return input + 1
	}
	let scopes: ReadonlyArray<Scope.Closeable> = []
	let providerScope: Scope.Closeable | undefined
	let environment: Context.Context<Counter> = Context.make(Counter, { call })
	const open = Effect.gen(function* () {
		const scope = yield* Scope.fork(root)
		yield* Layer.buildWithScope(Layer.effectDiscard(resource), scope)
		return scope
	})
	const loadIndependent = Effect.gen(function* () {
		scopes = yield* Effect.forEach(Array.range(1, spec.size), () => open)
	})
	const loadProvider = Effect.gen(function* () {
		providerScope = yield* Scope.fork(root)
		environment = yield* Layer.buildWithScope(
			Layer.effect(Counter, Effect.as(resource, { call })),
			providerScope,
		)
	})
	const loadDependents = Effect.gen(function* () {
		scopes = yield* Effect.forEach(Array.range(1, spec.size), () =>
			Effect.gen(function* () {
				const scope = yield* Scope.fork(root)
				yield* Layer.buildWithScope(
					Layer.effectDiscard(
						Effect.gen(function* () {
							yield* resource
							const service = yield* Counter
							state.value += service.call(0)
						}),
					).pipe(Layer.provide(Layer.succeedContext(environment))),
					scope,
				)
				return scope
			}),
		)
	})
	const loadFanout = Effect.andThen(loadProvider, loadDependents)
	const withdraw = Effect.gen(function* () {
		yield* Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), {
			discard: true,
		})
		if (providerScope !== undefined)
			yield* Scope.close(providerScope, Exit.void)
		environment = Context.make(Counter, { call })
	})
	let prepare: Effect.Effect<unknown> = Effect.void
	let run: Effect.Effect<number> = Effect.succeed(0)
	if (
		spec.scenario === "cold-load" ||
		String.startsWith("memory-")(spec.scenario)
	)
		run = Effect.as(loadIndependent, 0)
	if (spec.scenario === "memory-cycles")
		run = Effect.gen(function* () {
			yield* loadIndependent
			yield* Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), {
				discard: true,
			})
			scopes = []
			return 0
		})

	if (spec.scenario === "cold-dispose") {
		prepare = loadIndependent
		run = Effect.suspend(() =>
			Effect.as(
				Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void)),
				0,
			),
		)
	}
	if (spec.scenario === "fanout-load") run = Effect.as(loadFanout, 0)
	if (spec.scenario === "fanout-withdraw") {
		prepare = loadFanout
		run = Effect.as(withdraw, 0)
	}
	if (spec.scenario === "fanout-restore") {
		prepare = Effect.andThen(loadFanout, withdraw)
		run = Effect.as(loadFanout, 0)
	}
	if (spec.scenario === "chain")
		run = Effect.gen(function* () {
			const keys = Array.makeBy(spec.size, (i) =>
				Context.Service<{ readonly depth: number }>(`benchmark/chain/${i}`),
			)
			const first = keys[0]
			if (first === undefined)
				return yield* Effect.die(new Error("Chain must not be empty"))
			let chain = Context.make(first, { depth: 0 })
			for (const [i, key] of keys.entries()) {
				const previous = keys[i - 1]
				const build =
					previous === undefined
						? Effect.gen(function* () {
								yield* resource
								state.value = 1
								return { depth: 1 }
							})
						: Effect.gen(function* () {
								yield* resource
								const parent = yield* previous
								state.calls++
								state.value = parent.depth + 1
								return { depth: parent.depth + 1 }
							}).pipe(Effect.provideContext(chain))
				const scope = yield* Scope.fork(root)
				const next = yield* Layer.buildWithScope(
					Layer.effect(key, build),
					scope,
				)
				chain = Context.merge(chain, next)
			}
			return state.value
		})
	if (spec.scenario === "service") {
		let hot = Effect.succeed(0)
		prepare = Effect.gen(function* () {
			yield* loadProvider
			const scope = yield* Scope.fork(root)
			yield* resource.pipe(Scope.provide(scope))
			hot = Effect.gen(function* () {
				let sum = 0
				for (let i = 0; i < spec.calls; i++) {
					const service = yield* Counter
					sum += service.call(i)
				}
				state.value = sum
				return sum
			}).pipe(Effect.provideContext(environment))
		})
		run = Effect.suspend(() => hot)
	}
	if (String.startsWith("config-")(spec.scenario)) {
		prepare = Effect.gen(function* () {
			providerScope = yield* open
		})
		run = Effect.gen(function* () {
			if (spec.scenario === "config-restart") {
				if (providerScope !== undefined)
					yield* Scope.close(providerScope, Exit.void)
				providerScope = yield* open
			} else state.updates++
			state.value = 1
			return 1
		})
	}
	if (eventScenario(spec)) {
		const handlers = Array.makeBy(spec.size, (i) =>
			Effect.sync(() => {
				state.handlers++
				return i === spec.size - 1 ? 7 : 0
			}),
		)
		const bus = yield* PubSub.bounded<void>(1).pipe(Scope.provide(root))
		yield* Effect.addFinalizer(() => PubSub.shutdown(bus)).pipe(
			Scope.provide(root),
		)
		const subscriptions = yield* Effect.forEach(handlers, () =>
			PubSub.subscribe(bus),
		).pipe(Scope.provide(root))
		run = Effect.gen(function* () {
			let result = 0
			for (let i = 0; i < spec.calls; i++) {
				if (spec.scenario === "events-parallel") {
					const fibers = yield* Effect.forEach(subscriptions, (sub, index) =>
						Effect.forkScoped(
							Effect.andThen(PubSub.take(sub), handlers[index]!),
						),
					)
					yield* PubSub.publish(bus, undefined)
					yield* Effect.forEach(fibers, Fiber.join, { discard: true })
				} else if (spec.scenario === "events-waterfall") {
					const step: (index: number) => Effect.Effect<number> = (index) =>
						index === spec.size
							? Effect.sync(() => {
									state.terminals++
									return 0
								})
							: Effect.gen(function* () {
									state.handlers++
									return (yield* step(index + 1)) + 1
								})
					result = yield* step(0)
				} else {
					for (const handler of handlers) {
						const value = yield* handler
						if (String.endsWith("bail")(spec.scenario) && value !== 0) {
							result = value
							break
						}
					}
				}
			}
			state.value = result
			return result
		}).pipe(Effect.scoped)
	}
	yield* Effect.onError(prepare, () => Scope.close(root, Exit.void))
	return { run, close: Scope.close(root, Exit.void), read: snapshot(state) }
})
