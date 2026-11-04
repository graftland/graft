import { Application, ProtocolOutput } from "@graftland/cli/Application"
import * as Lifecycle from "../internal/RunnerLifecycle"
import { cleanupCause } from "../internal/cleanup"
import { Graft, Plugin, type Fork } from "@graftland/graft"
import { SecureRandom } from "effect/crypto"
import { Path } from "effect"
import { ModuleResolver } from "@graftland/loader"
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Option,
	Schema,
	Stream,
	Array,
} from "effect"
import * as Configuration from "../internal/entryConfig"
import { boundary, resolve } from "../internal/entry"
import * as Assembly from "../internal/assembly"
import * as Startup from "../internal/listenerStartup"
import { follow } from "../internal/follow"
import { Supervisor } from "../internal/Supervisor"
import supervisor, {
	Config as SupervisorConfig,
} from "../internal/supervisorPlugin"

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
	name: "remote-supervised-runtime",
	config: Configuration.Runner,
	inject: [
		ModuleResolver.ModuleResolver,
		Path.Path,
		SecureRandom.SecureRandom,
		Plugin.optional(Application),
	],
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
		const protocol = yield* ProtocolOutput
		if (
			Array.some(
				descriptions,
				(description) => description.properties.protocol === "stdio",
			) !== protocol
		)
			return yield* Lifecycle.StartupError.make({
				detail:
					"A stdio runner requires graft start --stdio and exactly one stdio listener",
			})
		if (protocol) {
			const application = yield* Effect.serviceOption(Application)
			if (Option.isSome(application)) yield* application.value.claimProtocol
		}
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
const shutdown = Effect.fnUntraced(function* (
	fork: Fork.Fork,
	lifecycle: typeof Lifecycle.RunnerLifecycle.Service,
) {
	const disposed = yield* Effect.exit(fork.dispose)
	const result = yield* Deferred.poll(lifecycle.released)
	const released = Option.isSome(result)
		? yield* Effect.exit(result.value)
		: Exit.void
	const cause = Cause.combine(
		Exit.isFailure(disposed) ? disposed.cause : Cause.empty,
		Exit.isFailure(released) ? released.cause : Cause.empty,
	)
	if (cause.reasons.length > 0)
		return yield* Effect.failCause(cleanupCause(cause))
})

export default Plugin.make({
	name: "remote-server",
	config: Schema.Unknown,
	inject: [Plugin.optional(Application)],
	apply: Effect.fnUntraced(function* (input) {
		const application = yield* Effect.serviceOption(Application)
		const config = yield* Schema.decodeUnknownEffect(Configuration.Runner)(
			input,
		).pipe(
			Effect.tapError((error) =>
				Option.isSome(application)
					? application.value.finish(Exit.fail(error))
					: Effect.void,
			),
		)
		const lifecycle = yield* Lifecycle.make
		const encoded = yield* Schema.encodeEffect(Configuration.Runner)(config)
		const assembly = Plugin.make({
			name: "remote-runner-runtime",
			apply: Effect.fnUntraced(function* () {
				yield* Graft.provide(Lifecycle.RunnerLifecycle, lifecycle)
				const fork = yield* Graft.plugin(owner, encoded)
				const fail = yield* boundary("runner")
				yield* follow(fork, fail)
			}),
		})
		const fork = yield* Graft.plugin(assembly, undefined, {
			isolate: [Supervisor, Lifecycle.RunnerLifecycle],
		})
		if (Option.isSome(application)) {
			yield* application.value.onExit(shutdown(fork, lifecycle))
			yield* Plugin.fork(
				Deferred.await(lifecycle.ended).pipe(
					Effect.matchCauseEffect({
						onSuccess: () => application.value.finish(Exit.void),
						onFailure: (cause) =>
							application.value.finish(Exit.failCause(cause)),
					}),
				),
			)
		}
		const fail = yield* boundary("runner")
		yield* follow(fork, (cause) =>
			(Option.isSome(application) && !Cause.hasInterruptsOnly(cause)
				? application.value.finish(Exit.failCause(cause))
				: Effect.void
			).pipe(Effect.andThen(fail(cause))),
		)
	}),
})
