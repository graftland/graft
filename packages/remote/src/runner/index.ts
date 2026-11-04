import { Graft, Plugin } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import { Deferred, Effect, Schema, Stream } from "effect"
import * as Configuration from "../internal/entryConfig"
import { boundary, resolve } from "../internal/entry"
import * as Assembly from "../internal/assembly"
import * as Startup from "../internal/listenerStartup"
import { follow } from "../internal/follow"
import { Supervisor } from "../Supervisor"
import supervisor, { Config as SupervisorConfig } from "./supervisor"

const startListener = Effect.fnUntraced(function* (
	input: Configuration.Listen,
	index: number,
	begin: Deferred.Deferred<void>,
) {
	const field = `listen[${index}]`
	const transport = yield* resolve(
		Configuration.runnerTransport(input),
		field + ".transport",
	)
	const auth = yield* resolve(
		Configuration.runnerAuthentication(input),
		field + ".auth",
	)
	const signals = yield* Startup.signals
	const consumer = Assembly.makeListenerConsumer(
		(properties, auth) =>
			Assembly.directAuth(properties, input.auth !== undefined).pipe(
				Effect.andThen(
					Deferred.succeed(signals.description, { properties, auth }),
				),
				Effect.andThen(Deferred.await(begin)),
			),
		Deferred.succeed(signals.ready, undefined).pipe(Effect.asVoid),
	)
	const fork = yield* Assembly.runner({ transport, auth }, consumer)
	return { fork, signals, field }
})

const owner = Plugin.make({
	name: "remote-runner-runtime",
	config: Configuration.Runner,
	inject: [ModuleResolver.ModuleResolver],
	apply: Effect.fnUntraced(function* (config) {
		const options = yield* Schema.encodeEffect(SupervisorConfig)(config)
		const engine = yield* Graft.plugin(supervisor, options)
		const fail = yield* boundary("supervisor")
		yield* follow(engine, fail)
		const begin = yield* Deferred.make<void>()
		const listeners = yield* Effect.forEach(config.listen, (input, index) =>
			startListener(input, index, begin),
		)
		const descriptions = yield* Effect.forEach(
			listeners,
			({ fork, signals }) => Startup.wait(fork, signals.description),
			{ concurrency: "unbounded" },
		)
		yield* Startup.validate(descriptions)
		yield* Deferred.succeed(begin, undefined)
		yield* Effect.forEach(
			listeners,
			({ fork, signals }) => Startup.wait(fork, signals.ready),
			{ concurrency: "unbounded" },
		)
		yield* Effect.forEach(
			listeners,
			({ fork, field }) =>
				Plugin.fork(
					fork.state.pipe(
						Stream.runForEach((state) =>
							state._tag === "Failed"
								? Effect.logWarning("Remote listener failed", state.cause).pipe(
										Effect.annotateLogs({ "remote.listener": field }),
									)
								: Effect.void,
						),
					),
				),
			{ discard: true },
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
