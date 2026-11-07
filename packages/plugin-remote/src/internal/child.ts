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
	SynchronizedRef,
	type Schema,
} from "effect"

import { Graft, Plugin, type Fork } from "@graftland/graft"

import { Instance, type Identity } from "../Instance"
import { ActivationFailed, AlreadyLoaded } from "./childErrors"
import { type RunnerContract } from "./contract"
import type { Event, Log, LogEvent } from "./control"
import { loadModule } from "./loadModule"
import type * as Port from "./port"

type Peer = Port.Port
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
export const telemetry = Effect.fnUntraced(function* (
	contract: RunnerContract,
) {
	const events = yield* Queue.bounded<ChildEvent>(2)
	const logs = yield* Queue.dropping<LogEntry, Cause.Done>(128)
	const dropped = MutableRef.make(0)
	const encode = (cause: Cause.Cause<unknown>) =>
		contract.encodeCause(cause).pipe(Effect.orDie)
	const encodedEmptyCause = yield* encode(Cause.empty)
	const emptyCause = Effect.succeed(encodedEmptyCause)
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
			Stream.mapArrayEffect((entries) =>
				// fromQueue drains at most the existing 128-record capacity. Preserve that
				// chunk through RPC, so one message and ACK cover all available entries.
				Effect.forEach(entries, (entry) =>
					(entry.cause.reasons.length === 0
						? emptyCause
						: encode(entry.cause)
					).pipe(
						Effect.map((cause): typeof LogEvent.Type => ({
							_tag: "Log",
							entry: { ...entry, cause },
							dropped: MutableRef.get(dropped),
						})),
					),
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
	readonly fork: Pick<
		Fork.Fork<never, unknown>,
		"dispose" | "state" | "probes" | "probe"
	>
	readonly bridge: Pick<Fork.Fork<never, never>, "dispose" | "state">
	readonly observation: Fiber.Fiber<void>
	readonly observedFailure: Ref.Ref<Cause.Cause<unknown>>
}
type Lifecycle = Data.TaggedEnum<{
	Idle: {}
	Loading: {}
	Running: { readonly running: Running }
	Withdrawing: { readonly running: Option.Option<Running> }
	Disposing: { readonly running: Option.Option<Running> }
}>
const Lifecycle = Data.taggedEnum<Lifecycle>()
const runningOf = (state: Lifecycle): Option.Option<Running> =>
	state._tag === "Running"
		? Option.some(state.running)
		: state._tag === "Withdrawing" || state._tag === "Disposing"
			? state.running
			: Option.none()

const cleanup = Effect.fnUntraced(function* (
	running: Running,
	retired: boolean,
) {
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
								reason._tag === "Fail" ? reason.error.cause.reasons : [reason],
							),
						),
					)
				: cause,
	)
})

export const lifecycle = Effect.fnUntraced(function* (
	contract: RunnerContract,
	implementation: string,
	peer: Peer,
	identity: typeof Identity.Type,
	telemetry: Telemetry,
) {
	const scope = yield* Effect.scope
	const definition = yield* Effect.cached(
		Effect.gen(function* () {
			const module = yield* loadModule(implementation)
			const plugin = Plugin.fromModule(module)
			if (Option.isNone(plugin))
				return yield* ActivationFailed.make({
					detail: "The implementation module exports no plugin",
				})
			return plugin.value
		}),
	)
	const describe = definition.pipe(
		Effect.mapBoth({
			onSuccess: (plugin) => ({
				name: plugin.name,
				overlap: plugin.overlap,
				provides: Array.map(plugin.provides, (provided) =>
					"operations" in provided
						? { key: provided.key.key, operations: provided.operations }
						: { key: provided.key, operations: [] },
				),
			}),
			onFailure: (error) => contract.normalizeCause(Cause.fail(error)),
		}),
	)
	const instanceScope = yield* Scope.fork(scope)
	const releaseExports = yield* Deferred.make<void>()
	const state = yield* SynchronizedRef.make<Lifecycle>(Lifecycle.Idle())
	// This gate represents host consumers draining, not a second lifecycle state.
	const disposing = (current: Lifecycle) =>
		Lifecycle.Disposing({ running: runningOf(current) })
	const release = SynchronizedRef.update(state, disposing).pipe(
		Effect.andThen(Deferred.succeed(releaseExports, undefined)),
	)

	const exportBridge = Graft.plugin(
		Plugin.make({
			name: `${contract.name}/exports`,
			inject: Array.map(contract.provides, (service) => service.key),
			apply: Effect.fnUntraced(function* () {
				for (const service of contract.provides)
					yield* service.serve(peer).pipe(
						Effect.tapCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.void
								: Queue.offer(telemetry.events, ChildEvent.Failed({ cause })),
						),
						Effect.forkScoped,
					)
				yield* Effect.addFinalizer(
					Effect.fnUntraced(function* () {
						const withdrawing = yield* SynchronizedRef.modify(
							state,
							(current) =>
								current._tag === "Disposing"
									? [false, current]
									: [
											true,
											Lifecycle.Withdrawing({
												running: runningOf(current),
											}),
										],
						)
						if (withdrawing)
							yield* Queue.offer(telemetry.events, ChildEvent.Withdrawing())
						yield* Deferred.await(releaseExports)
					}),
				)
			}),
		}),
	).pipe(Scope.provide(instanceScope))

	const start = Effect.fnUntraced(function* (input: Schema.Json) {
		// Imported clients outlive serving startup and remain available during plugin cleanup.
		for (const service of contract.inject)
			yield* service.publish(peer).pipe(
				Scope.provide(scope),
				Effect.mapError((error) =>
					ActivationFailed.make({
						detail: "Publishing imported services failed",
						cause: Cause.fail(error),
					}),
				),
			)
		const plugin = yield* definition
		const fork = yield* Graft.plugin(
			{ ...plugin, retry: undefined },
			input,
		).pipe(
			Effect.provideService(Instance, identity),
			Scope.provide(instanceScope),
		)
		const observedFailure = yield* Ref.make<Cause.Cause<unknown>>(Cause.empty)
		const observation = yield* fork.state.pipe(
			Stream.runForEach((state) =>
				state._tag === "Failed"
					? Ref.set(observedFailure, state.cause).pipe(
							Effect.andThen(
								Queue.offer(
									telemetry.events,
									ChildEvent.Failed({ cause: state.cause }),
								),
							),
						)
					: Effect.void,
			),
			Effect.forkIn(instanceScope),
		)
		const bridge = yield* exportBridge
		return { fork, bridge, observedFailure, observation } satisfies Running
	})
	const awaitActive = Effect.fnUntraced(function* (running: Running) {
		const first = yield* running.fork.state.pipe(
			Stream.filter((state) => state._tag !== "Loading"),
			Stream.runHead,
		)
		if (Option.isNone(first))
			return yield* ActivationFailed.make({
				detail: "The remote fork disappeared during startup",
			})
		if (first.value._tag === "Failed")
			return yield* Effect.fail(contract.normalizeCause(first.value.cause))
		if (first.value._tag !== "Active")
			return yield* ActivationFailed.make({
				detail:
					"The remote plugin did not become active; check its declared dependencies",
			})
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
			return yield* ActivationFailed.make({
				detail: "The remote export bridge failed during startup",
				cause: exported.value.cause,
			})
		if (Option.isNone(exported) || exported.value._tag !== "Active")
			return yield* ActivationFailed.make({
				detail: "The remote export bridge stopped during startup",
			})
	})
	const serve = Effect.fnUntraced(
		function* (input: Schema.Json) {
			yield* SynchronizedRef.updateEffect(state, (current) =>
				current._tag === "Idle"
					? Effect.succeed(Lifecycle.Loading())
					: Effect.fail(AlreadyLoaded.make({})),
			)
			const running = yield* start(input)
			const disposed = yield* SynchronizedRef.modify(
				state,
				(current): readonly [boolean, Lifecycle] =>
					current._tag === "Withdrawing"
						? [false, Lifecycle.Withdrawing({ running: Option.some(running) })]
						: current._tag === "Disposing"
							? [true, Lifecycle.Disposing({ running: Option.some(running) })]
							: [false, Lifecycle.Running({ running })],
			)
			// Stop saw startup in progress and found nothing to stop; serving owns the cleanup.
			if (disposed) {
				const cause = yield* cleanup(running, false)
				return yield* Effect.fail(
					Cause.combine(
						Cause.fail(
							ActivationFailed.make({
								detail: "The execution was stopped during startup",
							}),
						),
						cause,
					),
				)
			}
		},
		Effect.mapError((error) =>
			contract.normalizeCause(Cause.isCause(error) ? error : Cause.fail(error)),
		),
	)
	const dispose = Effect.gen(function* () {
		// One transition, so concurrent serving startup or export withdrawal cannot slip between read and write.
		const previous = yield* SynchronizedRef.getAndUpdate(state, disposing)
		yield* Deferred.succeed(releaseExports, undefined)
		const current = runningOf(previous)
		const retired = previous._tag === "Withdrawing"
		const cause = Option.isSome(current)
			? yield* cleanup(current.value, retired)
			: Cause.empty
		yield* Queue.offer(telemetry.events, ChildEvent.Stopped())
		yield* Queue.end(telemetry.logs)
		if (cause.reasons.length > 0)
			return yield* Effect.fail(contract.normalizeCause(cause))
	})
	const current = Effect.gen(function* () {
		const current = yield* SynchronizedRef.get(state)
		if (current._tag !== "Running")
			return yield* Effect.fail(
				contract.normalizeCause(
					Cause.fail(
						ActivationFailed.make({ detail: "The execution is not serving" }),
					),
				),
			)
		return current.running
	})
	const ready = current.pipe(
		Effect.flatMap((running) =>
			awaitActive(running).pipe(
				Effect.andThen(running.fork.probes),
				Effect.mapError((error) =>
					contract.normalizeCause(
						Cause.isCause(error) ? error : Cause.fail(error),
					),
				),
			),
		),
	)
	const probe = (name: string) =>
		current.pipe(
			Effect.flatMap((running) =>
				running.fork
					.probe(name)
					.pipe(
						Effect.catchTag("ProbeError", (error) =>
							Effect.fail(error.cause ?? Cause.fail(error)),
						),
					),
			),
			Effect.mapError((error) =>
				contract.normalizeCause(
					Cause.isCause(error) ? error : Cause.fail(error),
				),
			),
		)
	return { describe, serve, ready, probe, stop: dispose, release }
})
