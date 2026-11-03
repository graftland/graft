import { Graft, Plugin, type Fork } from "@graftland/graft"
import {
	Array,
	Cause,
	Data,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Logger,
	MutableRef,
	Option,
	Queue,
	Ref,
	References,
	Scope,
	Stream,
} from "effect"
import type { Schema } from "effect"
import { UndeclaredFailure, type RunnerContract } from "../Contract"
import { Instance, type Identity } from "../Instance"
import type * as Port from "./port"
import type { Event, Log, LogEvent } from "./control"

type Peer = Effect.Success<ReturnType<typeof Port.make>>
type ChildEvent = Data.TaggedEnum<{
	Failed: { readonly cause: Cause.Cause<unknown> }
	Withdrawing: {}
	Stopped: {}
}>
const ChildEvent = Data.taggedEnum<ChildEvent>()
type LogEntry = Omit<typeof Log.Type, "cause"> & {
	readonly cause: Cause.Cause<unknown>
}

/** Queue data; serialization belongs to the RPC consumer, outside synchronous logger callbacks. */
export const telemetry = (contract: RunnerContract) =>
	Effect.gen(function* () {
		const events = yield* Queue.bounded<ChildEvent>(2)
		const logs = yield* Queue.dropping<LogEntry, Cause.Done>(128)
		const dropped = MutableRef.make(0)
		const encode = (cause: Cause.Cause<unknown>) =>
			contract.encodeCause(cause).pipe(Effect.orDie)
		const logger = Logger.make((entry) => {
			// Logger callbacks are synchronous; a dropping offer and loss counter cannot suspend.
			const accepted = Queue.offerUnsafe(logs, {
				level: entry.logLevel,
				message: entry.message,
				cause: entry.cause,
				annotations: entry.fiber.getRef(References.CurrentLogAnnotations),
			})
			if (!accepted) MutableRef.increment(dropped)
		})
		return {
			events,
			logs,
			logger,
			eventStream: Stream.fromQueue(events).pipe(
				Stream.mapEffect((event): Effect.Effect<typeof Event.Type> =>
					event._tag === "Failed"
						? encode(event.cause).pipe(
								Effect.map(
									(cause) =>
										({
											_tag: "Failed",
											cause,
										}) satisfies typeof Event.Type,
								),
							)
						: Effect.succeed(event),
				),
			),
			logStream: Stream.fromQueue(logs).pipe(
				Stream.mapEffect((entry) =>
					encode(entry.cause).pipe(
						Effect.map((cause): typeof LogEvent.Type => ({
							_tag: "Log",
							entry: { ...entry, cause },
							dropped: MutableRef.get(dropped),
						})),
					),
				),
				Stream.concat(
					Stream.sync((): typeof LogEvent.Type => ({
						_tag: "LogsEnded",
						dropped: MutableRef.get(dropped),
					})),
				),
			),
		}
	})
type Telemetry = Effect.Success<ReturnType<typeof telemetry>>
interface Running {
	readonly fork: Pick<Fork.Fork<never, unknown>, "dispose" | "state">
	readonly bridge: Pick<Fork.Fork<never, never>, "dispose" | "state">
	readonly observation: Fiber.Fiber<void>
	readonly observedFailure: Ref.Ref<Cause.Cause<unknown>>
}
const cleanup = (running: Running, retired: boolean) =>
	Effect.gen(function* () {
		const pluginExit = yield* Effect.exit(running.fork.dispose)
		const bridgeExit = yield* Effect.exit(running.bridge.dispose)
		yield* Fiber.join(running.observation)
		const failed = yield* Ref.get(running.observedFailure)
		return Array.reduce(
			[bridgeExit, pluginExit],
			retired ? failed : Cause.empty,
			(cause, exit) =>
				Exit.isFailure(exit)
					? Cause.combine(
							cause,
							Cause.fromReasons(
								Array.flatMap(exit.cause.reasons, (reason) =>
									reason._tag === "Fail"
										? reason.error.cause.reasons
										: [reason],
								),
							),
						)
					: cause,
		)
	})

export const lifecycle = (
	contract: RunnerContract,
	peer: Peer,
	identity: typeof Identity.Type,
	telemetry: Telemetry,
) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const instanceScope = yield* Scope.fork(scope)
		const releaseExports = yield* Deferred.make<void>()
		const exportsReady = yield* Deferred.make<void>()
		const hostDisposing = yield* Ref.make(false)
		const withdrawing = yield* Ref.make(false)
		const instance = yield* Ref.make(Option.none<Running>())
		const release = Ref.set(hostDisposing, true).pipe(
			Effect.andThen(Deferred.succeed(releaseExports, undefined)),
		)

		const exportBridge = Graft.plugin(
			Plugin.make({
				name: `${contract.name}/exports`,
				inject: Array.map(contract.provides, (service) => service.key),
				apply: () =>
					Effect.gen(function* () {
						for (const service of contract.provides)
							yield* service.serve(peer).pipe(Effect.forkScoped)
						yield* Deferred.succeed(exportsReady, undefined)
						yield* Effect.addFinalizer(() =>
							Effect.gen(function* () {
								if (!(yield* Ref.get(hostDisposing))) {
									yield* Ref.set(withdrawing, true)
									yield* Queue.offer(telemetry.events, ChildEvent.Withdrawing())
								}
								yield* Deferred.await(releaseExports)
							}),
						)
					}),
			}),
		).pipe(Scope.provide(instanceScope))

		const start = (input: Schema.Json) =>
			Effect.gen(function* () {
				// Imported clients outlive Load and remain available during plugin cleanup.
				for (const service of contract.inject)
					yield* service.publish(peer).pipe(Scope.provide(scope), Effect.orDie)
				const module = yield* Effect.tryPromise({
					try: () => import(contract.module),
					catch: (cause) => UndeclaredFailure.make({ original: cause }),
				}).pipe(Effect.orDie)
				const plugin = Plugin.fromModule(module)
				if (Option.isNone(plugin))
					return yield* Effect.die(
						new Error("The implementation module exports no plugin"),
					)
				const fork = yield* Graft.plugin(
					{ ...plugin.value, retry: undefined },
					input,
				).pipe(
					Effect.provideService(Instance, identity),
					Scope.provide(instanceScope),
				)
				const observedFailure = yield* Ref.make<Cause.Cause<unknown>>(
					Cause.empty,
				)
				const observation = yield* fork.state.pipe(
					Stream.runForEach((state) =>
						state._tag === "Failed"
							? Ref.set(observedFailure, state.cause)
							: Effect.void,
					),
					Effect.forkIn(instanceScope),
				)
				const bridge = yield* exportBridge
				return { fork, bridge, observedFailure, observation } satisfies Running
			})
		const awaitActive = (running: Running) =>
			Effect.gen(function* () {
				const first = yield* running.fork.state.pipe(
					Stream.filter((state) => state._tag !== "Loading"),
					Stream.runHead,
				)
				if (Option.isNone(first))
					return yield* Effect.die(
						new Error("The remote fork disappeared during startup"),
					)
				if (first.value._tag === "Failed")
					return yield* Effect.fail(contract.normalizeCause(first.value.cause))
				if (first.value._tag !== "Active")
					return yield* Effect.die(
						new Error(
							"The remote plugin did not become active; check its declared dependencies",
						),
					)
				yield* running.fork.state.pipe(
					Stream.runForEach((state) =>
						state._tag === "Failed"
							? Queue.offer(
									telemetry.events,
									ChildEvent.Failed({ cause: state.cause }),
								)
							: Effect.void,
					),
					Effect.forkIn(instanceScope),
				)
				const exported = yield* running.bridge.state.pipe(
					Stream.filter(
						(state) =>
							state._tag === "Active" ||
							state._tag === "Failed" ||
							state._tag === "Disposed",
					),
					Stream.runHead,
				)
				if (Option.isSome(exported) && exported.value._tag === "Failed")
					return yield* Effect.failCause(exported.value.cause).pipe(
						Effect.orDie,
					)
				if (Option.isNone(exported) || exported.value._tag !== "Active")
					return yield* Effect.die(
						new Error("The remote export bridge stopped during startup"),
					)
				yield* Deferred.await(exportsReady)
			})
		const load = (input: Schema.Json) =>
			Effect.gen(function* () {
				const current = yield* Ref.get(instance)
				if (Option.isSome(current))
					return yield* Effect.die(
						new Error("This runner already owns an instance"),
					)
				const running = yield* start(input)
				yield* Ref.set(instance, Option.some(running))
				yield* awaitActive(running)
			})
		const dispose = Effect.gen(function* () {
			yield* release
			const current = yield* Ref.get(instance)
			const retired = yield* Ref.get(withdrawing)
			const cause = Option.isSome(current)
				? yield* cleanup(current.value, retired)
				: Cause.empty
			yield* Queue.offer(telemetry.events, ChildEvent.Stopped())
			yield* Queue.end(telemetry.logs)
			if (cause.reasons.length > 0)
				return yield* Effect.fail(contract.normalizeCause(cause))
		})
		return { load, dispose, release }
	})
