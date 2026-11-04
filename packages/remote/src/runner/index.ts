import { Graft, Plugin } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import { Effect, Schema } from "effect"
import * as Configuration from "../internal/entryConfig"
import { boundary, resolve } from "../internal/entry"
import * as Assembly from "../internal/assembly"
import { follow } from "../internal/follow"
import { Supervisor } from "../Supervisor"
import supervisor, { Config as SupervisorConfig } from "./supervisor"

const owner = Plugin.make({
	name: "remote-runner-runtime",
	config: Configuration.Runner,
	inject: [ModuleResolver.ModuleResolver],
	apply: Effect.fnUntraced(function* (config) {
		const options = yield* Schema.encodeEffect(SupervisorConfig)(config)
		const engine = yield* Graft.plugin(supervisor, options)
		const fail = yield* boundary("supervisor")
		yield* follow(engine, fail)
		yield* Effect.forEach(
			config.listen,
			Effect.fnUntraced(function* (input, index) {
				const field = `listen[${index}]`
				const transport = yield* resolve(
					Configuration.runnerTransport(input),
					field + ".transport",
				)
				const auth = yield* resolve(
					Configuration.authentication("runner", input.auth),
					field + ".auth",
				)
				const listener = yield* Assembly.runner({ transport, auth })
				const fail = yield* boundary(field)
				// Runtime listener failures stay in their own assembly; startup failures still reach the entry.
				yield* listener.await.pipe(Effect.catchCause(fail))
			}),
		)
	}),
})
export default Plugin.make({
	name: "remote-runner",
	config: Configuration.Runner,
	apply: Effect.fnUntraced(function* (config) {
		const encoded = yield* Schema.encodeEffect(Configuration.Runner)(config)
		const fork = yield* Graft.plugin(owner, encoded, { isolate: [Supervisor] })
		const fail = yield* boundary("runner")
		yield* follow(fork, fail)
	}),
})
