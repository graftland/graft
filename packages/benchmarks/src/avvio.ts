import { Array, Effect } from "effect"

import avvio from "avvio"

import { audit, snapshot, type Case, type Fixture } from "./model"

export const make = Effect.fnUntraced(function* (
	spec: Case,
): Effect.fn.Return<Fixture> {
	const state = audit()
	const call = (input: number) => {
		state.calls++
		return input + 1
	}
	const application: {
		services: ReadonlyArray<number>
		counter?: { readonly call: (input: number) => number }
	} = { services: [] }
	const app = avvio(application, { autostart: false })
	const resource = () => {
		state.activations++
		app.onClose((_instance, done) => {
			state.finalizers++
			done()
		})
	}
	let hot = () => 0
	const load = Effect.gen(function* () {
		if (spec.scenario === "fanout-load" || spec.scenario === "service")
			app.use((_server, _options, done) => {
				resource()
				_server.counter = { call }
				done()
			})
		for (let i = 0; i < (spec.scenario === "service" ? 1 : spec.size); i++)
			app.use((server, _options, done) => {
				resource()
				if (spec.scenario === "chain") {
					const previous = i === 0 ? 0 : server.services[i - 1]
					if (previous === undefined)
						return done(new Error("Previous chain service is missing"))
					if (i > 0) state.calls++
					server.services = Array.append(server.services, previous + 1)
					state.value = previous + 1
				}
				if (spec.scenario === "fanout-load")
					state.value += server.counter!.call(0)
				if (spec.scenario === "service")
					hot = () => {
						let sum = 0
						for (let j = 0; j < spec.calls; j++) sum += server.counter!.call(j)
						state.value = sum
						return sum
					}
				done()
			})
		yield* Effect.promise(() => app.ready())
		return spec.scenario === "chain" ? state.value : 0
	})
	// The installed declaration omits the documented no-argument Promise overload.
	const close = Effect.promise(() => app[Symbol.asyncDispose]())
	let run = load
	if (spec.scenario === "events-emit") {
		app.setMaxListeners(spec.size)
		for (let i = 0; i < spec.size; i++)
			app.addListener("benchmark", () => {
				state.handlers++
			})
		run = Effect.sync(() => {
			for (let i = 0; i < spec.calls; i++) app.emit("benchmark")
			return 0
		})
	}
	if (spec.scenario === "cold-dispose") {
		yield* load
		run = Effect.as(close, 0)
	}
	if (spec.scenario === "service") {
		yield* load
		run = Effect.sync(() => hot())
	}
	return { run, close, read: snapshot(state) }
})
