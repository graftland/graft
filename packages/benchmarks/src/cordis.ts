import { Array, Effect, String } from "effect"

import { Context, type Fiber } from "cordis"

import {
	audit,
	check,
	eventScenario,
	snapshot,
	type Case,
	type Fixture,
} from "./model"

declare module "cordis" {
	interface Context {
		benchmarkCounter: { readonly call: (input: number) => number }
	}
}
const Broadcast = Symbol("benchmark broadcast")
const Bail = Symbol("benchmark bail")
const Waterfall = Symbol("benchmark waterfall")
const settled = (fiber: Fiber, expected = 2) =>
	Effect.andThen(
		Effect.promise(() => fiber.await()),
		Effect.suspend(() =>
			check(
				fiber.state === expected,
				"Cordis fiber did not reach the expected state",
			),
		),
	)

export const make = Effect.fnUntraced(function* (
	spec: Case,
): Effect.fn.Return<Fixture> {
	const state = audit()
	const root = new Context()
	const resource = (ctx: Context) =>
		ctx.effect(() => {
			state.activations++
			return () => {
				state.finalizers++
			}
		})
	const call = (input: number) => {
		state.calls++
		return input + 1
	}
	const independent = (ctx: Context) => {
		resource(ctx)
	}
	const provider = (ctx: Context) => {
		resource(ctx)
		ctx.provide("benchmarkCounter", { call })
	}
	const dependent = {
		inject: ["benchmarkCounter"],
		apply: (ctx: Context) => {
			resource(ctx)
			state.value += ctx.benchmarkCounter.call(0)
		},
	}
	let forks: ReadonlyArray<Fiber> = []
	let providerFiber: Fiber | undefined
	const loadIndependent = Effect.gen(function* () {
		forks = Array.makeBy(spec.size, () => root.plugin(independent))
		yield* Effect.forEach(forks, (fiber) => settled(fiber), { discard: true })
	})
	const loadFanout = Effect.gen(function* () {
		providerFiber = root.plugin(provider)
		yield* settled(providerFiber)
		forks = Array.makeBy(spec.size, () => root.plugin(dependent))
		yield* Effect.forEach(forks, (fiber) => settled(fiber), { discard: true })
	})
	const withdraw = Effect.gen(function* () {
		if (providerFiber === undefined)
			return yield* Effect.die(new Error("Provider was not loaded"))
		yield* Effect.promise(() => providerFiber!.dispose())
		yield* Effect.forEach(forks, (fiber) => settled(fiber, 0), {
			discard: true,
		})
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
			yield* Effect.forEach(
				forks,
				(fiber) => Effect.promise(() => fiber.dispose()),
				{ discard: true },
			)
			forks = []
			return 0
		})

	if (spec.scenario === "cold-dispose") {
		prepare = loadIndependent
		run = Effect.suspend(() =>
			Effect.as(
				Effect.forEach(forks, (fiber) => Effect.promise(() => fiber.dispose())),
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
			providerFiber = root.plugin(provider)
			yield* settled(providerFiber)
			yield* Effect.forEach(forks, (fiber) => settled(fiber), { discard: true })
			return 0
		})
	}
	if (spec.scenario === "chain")
		run = Effect.gen(function* () {
			for (let i = 0; i < spec.size; i++) {
				const key = `benchmarkChain${i}`
				const previous = `benchmarkChain${i - 1}`
				const plugin = {
					inject: i === 0 ? [] : [previous],
					apply: (ctx: Context) => {
						resource(ctx)
						const parent: unknown = i === 0 ? 0 : ctx.get(previous)
						if (typeof parent !== "number")
							throw new Error("Chain service is not a number")
						if (i > 0) state.calls++
						state.value = parent + 1
						ctx.provide(key, parent + 1)
					},
				}
				const fiber = root.plugin(plugin)
				yield* settled(fiber)
			}
			return state.value
		})
	if (spec.scenario === "service") {
		let invoke = () => 0
		prepare = Effect.gen(function* () {
			providerFiber = root.plugin(provider)
			yield* settled(providerFiber)
			const fiber = root.plugin({
				inject: ["benchmarkCounter"],
				apply: (ctx: Context) => {
					resource(ctx)
					invoke = () => {
						let sum = 0
						for (let i = 0; i < spec.calls; i++)
							sum += ctx.benchmarkCounter.call(i)
						state.value = sum
						return sum
					}
				},
			})
			yield* settled(fiber)
		})
		run = Effect.sync(() => invoke())
	}
	if (String.startsWith("config-")(spec.scenario)) {
		prepare = Effect.gen(function* () {
			providerFiber = root.plugin(
				(ctx: Context, config: { readonly value: number }) => {
					resource(ctx)
					state.value = config.value
					if (spec.scenario === "config-update")
						ctx.on("internal/update", (next: { readonly value: number }) => {
							state.updates++
							state.value = next.value
						})
				},
				{ value: 0 },
			)
			yield* settled(providerFiber)
		})
		run = Effect.gen(function* () {
			const fiber = providerFiber
			if (fiber === undefined)
				return yield* Effect.die(
					new Error("Configurable plugin was not loaded"),
				)
			yield* Effect.promise(() => Promise.resolve(fiber.update({ value: 1 })))
			yield* settled(fiber)
			return state.value
		})
	}
	if (eventScenario(spec)) {
		prepare = Effect.sync(() => {
			for (let i = 1; i <= spec.size; i++) {
				if (spec.scenario === "events-waterfall")
					root.on(Waterfall, (next: () => number) => {
						state.handlers++
						return next() + 1
					})
				else if (String.endsWith("bail")(spec.scenario))
					root.on(Bail, () => {
						state.handlers++
						return i === spec.size ? 7 : undefined
					})
				else
					root.on(Broadcast, () => {
						state.handlers++
					})
			}
		})
		run = Effect.gen(function* () {
			let result = 0
			for (let i = 0; i < spec.calls; i++) {
				if (spec.scenario === "events-emit") root.emit(Broadcast)
				else if (spec.scenario === "events-parallel")
					yield* Effect.promise(() => root.parallel(Broadcast))
				else if (spec.scenario === "events-sequential")
					yield* Effect.promise(() => root.serial(Broadcast))
				else if (spec.scenario === "events-serial-bail") {
					const value: unknown = yield* Effect.promise(() => root.serial(Bail))
					if (typeof value === "number") result = value
				} else if (spec.scenario === "events-bail") {
					const value: unknown = root.bail(Bail)
					if (typeof value === "number") result = value
				} else {
					const value: unknown = root.waterfall(Waterfall, () => {
						state.terminals++
						return 0
					})
					if (typeof value === "number") result = value
				}
			}
			state.value = result
			return result
		})
	}
	const close = Effect.promise(() => root.fiber.dispose())
	yield* Effect.onError(prepare, () => close)
	return { run, close, read: snapshot(state) }
})
