import {
	Array,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Schema,
	Scope,
	Stream,
	String,
} from "effect"

import {
	Event,
	Graft,
	Plugin,
	type Fork,
	type Transition,
} from "@graftland/graft"

import {
	audit,
	check,
	eventScenario,
	snapshot,
	type Case,
	type Fixture,
} from "./model"

class Counter extends Context.Service<
	Counter,
	{ readonly call: (input: number) => number }
>()("@graftland/benchmarks/graft/Counter") {}
const active = <I, E>(fork: Fork.Fork<I, E>) =>
	Effect.gen(function* () {
		yield* fork.await
		const state = yield* Stream.runHead(fork.state)
		yield* check(
			Option.isSome(state) && state.value._tag === "Active",
			"Graft fork did not become Active",
		)
	})

export const make = Effect.fnUntraced(function* (
	spec: Case,
): Effect.fn.Return<Fixture> {
	const state = audit()
	const scope = yield* Scope.make()
	const context = yield* Layer.buildWithScope(Layer.fresh(Graft.layer), scope)
	const start = Effect.sync(() => {
		state.activations++
	})
	const finish = Effect.sync(() => {
		state.finalizers++
	})
	const resource = Effect.andThen(
		start,
		Effect.addFinalizer(() => finish),
	)
	const independent = (name = "independent") =>
		Plugin.make({ name, apply: () => resource })
	const independentPlugin = independent()
	const call = (input: number) => {
		state.calls++
		return input + 1
	}
	const provider = Plugin.make({
		name: "provider",
		apply: () => Effect.andThen(resource, Graft.provide(Counter, { call })),
	})
	const dependent = Plugin.make({
		name: "dependent",
		inject: [Counter],
		apply: () =>
			Effect.gen(function* () {
				yield* resource
				const service = yield* Counter
				state.value += service.call(0)
			}),
	})
	let forks: ReadonlyArray<
		Fork.Fork<void, Schema.SchemaError | Graft.ServiceConflict>
	> = []
	let providerFork:
		Fork.Fork<void, Schema.SchemaError | Graft.ServiceConflict> | undefined
	let configFork:
		Fork.Fork<{ readonly value: number }, Schema.SchemaError> | undefined
	const loadIndependent = Effect.gen(function* () {
		forks = yield* Effect.forEach(Array.range(1, spec.size), () =>
			Graft.plugin(independentPlugin),
		)
		yield* Effect.forEach(forks, active, { discard: true })
	})
	const loadFanout = Effect.gen(function* () {
		providerFork = yield* Graft.plugin(provider)
		yield* active(providerFork)
		forks = yield* Effect.forEach(Array.range(1, spec.size), () =>
			Graft.plugin(dependent),
		)
		yield* Effect.forEach(forks, active, { discard: true })
	})
	const withdraw = Effect.gen(function* () {
		if (providerFork === undefined)
			return yield* Effect.die(new Error("Provider was not loaded"))
		yield* providerFork.dispose
		yield* Effect.forEach(
			forks,
			(fork) =>
				fork.state.pipe(
					Stream.filter((value) => value._tag === "Pending"),
					Stream.runHead,
				),
			{ discard: true },
		)
	})
	let run: Effect.Effect<
		number,
		| Schema.SchemaError
		| Graft.ServiceConflict
		| Fork.CleanupError
		| Graft.ReplacementConflict
		| Transition.ManagedFork,
		Graft.Graft | Scope.Scope
	> = Effect.succeed(0)
	let prepare: Effect.Effect<
		unknown,
		| Schema.SchemaError
		| Graft.ServiceConflict
		| Fork.CleanupError
		| Transition.ManagedFork,
		Graft.Graft | Scope.Scope
	> = Effect.void
	if (
		spec.scenario === "cold-load" ||
		String.startsWith("memory-")(spec.scenario)
	)
		run = Effect.as(loadIndependent, 0)
	if (spec.scenario === "memory-cycles")
		run = Effect.gen(function* () {
			yield* loadIndependent
			yield* Effect.forEach(forks, (fork) => fork.dispose, { discard: true })
			forks = []
			return 0
		})

	if (spec.scenario === "cold-dispose") {
		prepare = loadIndependent
		run = Effect.suspend(() =>
			Effect.as(
				Effect.forEach(forks, (fork) => fork.dispose),
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
		run = Effect.gen(function* () {
			providerFork = yield* Graft.plugin(provider)
			yield* active(providerFork)
			yield* Effect.forEach(forks, active, { discard: true })
			return 0
		})
	}
	if (spec.scenario === "chain")
		run = Effect.gen(function* () {
			const keys = Array.makeBy(spec.size, (i) =>
				Context.Service<{ readonly depth: number }>(`benchmark/chain/${i}`),
			)
			for (const [i, key] of keys.entries()) {
				const previous = keys[i - 1]
				const plugin =
					previous === undefined
						? Plugin.make({
								name: "chain root",
								apply: () =>
									Effect.gen(function* () {
										yield* resource
										state.value = 1
										yield* Graft.provide(key, { depth: 1 })
									}),
							})
						: Plugin.make({
								name: "chain link",
								inject: [previous],
								apply: () =>
									Effect.gen(function* () {
										yield* resource
										const parent = yield* previous
										state.calls++
										state.value = parent.depth + 1
										yield* Graft.provide(key, { depth: parent.depth + 1 })
									}),
							})
				const fork = yield* Graft.plugin(plugin)
				yield* active(fork)
			}
			return state.value
		})
	if (spec.scenario === "service") {
		let hot: Effect.Effect<number> = Effect.succeed(0)
		prepare = Effect.gen(function* () {
			const p = yield* Graft.plugin(provider)
			yield* active(p)
			const d = yield* Graft.plugin(
				Plugin.make({
					name: "service caller",
					inject: [Counter],
					apply: () =>
						Effect.gen(function* () {
							yield* resource
							const invoke = Effect.gen(function* () {
								let sum = 0
								for (let i = 0; i < spec.calls; i++) {
									const service = yield* Counter
									sum += service.call(i)
								}
								state.value = sum
								return sum
							})
							const services = yield* Effect.context<Counter>()
							hot = Effect.provideContext(invoke, services)
						}),
				}),
			)
			yield* active(d)
		})
		run = Effect.suspend(() => hot)
	}
	if (String.startsWith("config-")(spec.scenario)) {
		const plugin = Plugin.make({
			name: "configurable",
			config: Schema.Struct({ value: Schema.Int }),
			apply: (config) =>
				Effect.gen(function* () {
					yield* resource
					state.value = config.value
					if (spec.scenario === "config-update")
						return (next: { readonly value: number }) =>
							Effect.sync(() => {
								state.updates++
								state.value = next.value
								return true
							})
					return undefined
				}),
		})
		prepare = Effect.gen(function* () {
			configFork = yield* Graft.plugin(plugin, { value: 0 })
			yield* active(configFork)
		})
		run = Effect.gen(function* () {
			if (configFork === undefined)
				return yield* Effect.die(
					new Error("Configurable plugin was not loaded"),
				)
			yield* configFork.update({ value: 1 })
			yield* active(configFork)
			return state.value
		})
	}
	if (spec.scenario === "replace") {
		const pairs = Array.makeBy(
			spec.size,
			() => [independent("original"), independent("replacement")] as const,
		)
		prepare = Effect.gen(function* () {
			forks = yield* Effect.forEach(pairs, ([from]) => Graft.plugin(from))
			yield* Effect.forEach(forks, active)
		})
		run = Effect.gen(function* () {
			const result = yield* Graft.replace(pairs)
			if (result._tag !== "Replaced") return yield* Effect.die(result)
			yield* Graft.forks.pipe(
				Stream.filter(
					(tree) =>
						tree.length === spec.size &&
						Array.every(
							tree,
							(fork) =>
								fork.name === "replacement" && fork.state._tag === "Active",
						),
				),
				Stream.runHead,
			)
			yield* Effect.forEach(forks, active)
			return 0
		})
	}
	if (eventScenario(spec)) {
		const broadcast = Event.make<[], void>("benchmark/broadcast")
		const bail = Event.make<[], Option.Option<number>>("benchmark/bail")
		const waterfall = Event.middleware<number, number>("benchmark/waterfall")
		prepare = Effect.forEach(Array.range(1, spec.size), (i) => {
			if (spec.scenario === "events-waterfall")
				return Event.on(waterfall, (input, next) =>
					Effect.gen(function* () {
						state.handlers++
						return (yield* next(input)) + 1
					}),
				)
			if (String.endsWith("bail")(spec.scenario))
				return Event.on(bail, () =>
					Effect.sync(() => {
						state.handlers++
						return i === spec.size ? Option.some(7) : Option.none()
					}),
				)
			return Event.on(broadcast, () =>
				Effect.sync(() => {
					state.handlers++
				}),
			)
		})
		run = Effect.gen(function* () {
			let result = 0
			for (let i = 0; i < spec.calls; i++) {
				if (spec.scenario === "events-waterfall")
					result = yield* Event.waterfall(waterfall, 0, (input) =>
						Effect.sync(() => {
							state.terminals++
							return input
						}),
					)
				else if (String.endsWith("bail")(spec.scenario)) {
					const value = yield* Event.bail(bail)
					result = Option.getOrElse(value, () => 0)
				} else if (spec.scenario === "events-parallel")
					yield* Event.parallel(broadcast)
				else yield* Event.emit(broadcast)
			}
			state.value = result
			return result
		})
	}
	const supply = <A, E>(
		effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
	) =>
		effect.pipe(
			Scope.provide(scope),
			Effect.provideContext(context),
			Effect.orDie,
		)
	yield* Effect.onError(supply(prepare), () => Scope.close(scope, Exit.void))
	return {
		run: supply(run),
		close: Scope.close(scope, Exit.void),
		read: snapshot(state),
	}
})
