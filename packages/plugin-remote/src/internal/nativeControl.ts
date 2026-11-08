/** Fixed native placement executor. Business modules are never imported here. */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native process creation and exact exit observation are the placement boundary.
import { spawn, type ChildProcess } from "node:child_process"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

import {
	Cause,
	Deferred,
	Effect,
	Exit,
	FiberSet,
	HashMap,
	HashSet,
	Layer,
	Option,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"
import { Digest } from "effect/crypto"

import {
	UnitControl,
	type Command,
	type Report,
	type UnitEvent,
} from "@graftland/graft/Kernel"

import * as CallFrames from "./callFrames"
import * as EncodedLimit from "./encodedLimit"
import * as RunnerClient from "./runnerClient"
import * as Bridge from "./stdioBridge"
import * as Wire from "./unitProtocol"
import * as Resolution from "./unitResolution"

class NativeFailure extends Schema.TaggedError<
	NativeFailure,
	{ readonly brand: unique symbol }
>()("NativeFailure", { cause: Schema.Cause(Schema.Unknown, Schema.Unknown) }) {}
interface Handle {
	readonly command: Command
	readonly send: (message: Wire.Incoming) => Effect.Effect<void>
	readonly terminate: Effect.Effect<void>
	readonly online: Deferred.Deferred<void>
	readonly initialized: Deferred.Deferred<void>
	readonly ended: Deferred.Deferred<void>
	readonly pending: Ref.Ref<HashMap.HashMap<string, Deferred.Deferred<Report>>>
}
interface Runtime {
	readonly scope: Scope.Scope
	readonly handles: Ref.Ref<HashMap.HashMap<string, Handle>>
	readonly prevented: Ref.Ref<HashSet.HashSet<string>>
	readonly requests: Queue.Queue<UnitEvent>
	readonly events: Queue.Queue<UnitEvent>
	readonly callbacks: FiberSet.FiberSet<void, never>
	readonly run: (effect: Effect.Effect<void>) => unknown
	readonly stdio: Option.Option<Bridge.Bridge>
}
const failed = (
	cause: Cause.Cause<unknown>,
	creation: "Unknown" | "NotStarted" = "Unknown",
): Report => ({ _tag: "Failed", cause, creation })
const unitEvent = (command: Command) => ({
	unit: command.unit,
	incarnation: command.token.incarnation,
	observer: command.id,
})
const decodeReport = Effect.fnUntraced(function* (
	result: Wire.Report,
): Effect.fn.Return<Report, Schema.SchemaError> {
	if (result._tag !== "Failed") return result
	const cause = yield* Schema.decodeEffect(Wire.Cause)(result.cause)
	return { ...result, cause }
})
const message = Effect.fnUntraced(
	function* (runtime: Runtime, handle: Handle, value: unknown) {
		yield* EncodedLimit.check(value)
		const decoded = yield* Wire.decodeOutgoing(value).pipe(Effect.exit)
		if (Exit.isFailure(decoded)) {
			yield* Queue.offer(runtime.events, {
				_tag: "UnitFailed",
				...unitEvent(handle.command),
				cause: decoded.cause,
			})
			return
		}
		const frame = decoded.value
		switch (frame._tag) {
			case "MemberReady":
				yield* Queue.offer(runtime.events, {
					...unitEvent(handle.command),
					...frame,
				})
				return
			case "MemberFailed":
				yield* Queue.offer(runtime.events, {
					...unitEvent(handle.command),
					...frame,
					cause: yield* Schema.decodeEffect(Wire.Cause)(frame.cause),
				})
				return
			case "MemberStopped": {
				const cause = yield* Schema.decodeEffect(Wire.Cause)(frame.cause)
				yield* Queue.offer(runtime.events, {
					...unitEvent(handle.command),
					...frame,
					cause,
					cleanup:
						frame.cleanup === "Completed"
							? { _tag: "Completed" }
							: frame.cleanup === "Failed"
								? { _tag: "Failed", cause }
								: { _tag: "Unknown" },
				})
				return
			}
			case "Call":
				yield* Queue.offer(
					frame.message._tag === "Request" ? runtime.requests : runtime.events,
					{
						_tag: "CallObserved",
						...unitEvent(handle.command),
						message: yield* CallFrames.decode(frame.message),
					},
				)
				return
			case "Online":
				yield* Deferred.succeed(handle.online, undefined)
				return
			case "Initialized":
				yield* Deferred.succeed(handle.initialized, undefined)
				return
			case "Progress":
				yield* Queue.offer(runtime.events, {
					_tag: "UnitProgress",
					...unitEvent(handle.command),
					stage: frame.stage,
				})
				return
			/** Only the holding incarnation's output reaches the kernel's stdout. */
			case "StdioClaim": {
				const granted = yield* Option.match(runtime.stdio, {
					onNone: () => Effect.succeed(false),
					onSome: (bridge) =>
						bridge.claim({
							unit: handle.command.unit,
							incarnation: handle.command.token.incarnation,
							deliver: (input) =>
								handle.send(
									input._tag === "Bytes"
										? { _tag: "StdioIn", bytes: input.bytes }
										: { _tag: "StdioEnd" },
								),
							ended: Deferred.await(handle.ended),
						}),
				})
				yield* handle.send({ _tag: granted ? "StdioGranted" : "StdioDenied" })
				return
			}
			case "StdioOut":
			case "StdioClose":
			case "StdioRelease":
				yield* Option.match(runtime.stdio, {
					onNone: () => Effect.void,
					onSome: (bridge) =>
						frame._tag === "StdioOut"
							? bridge.write(
									handle.command.unit,
									handle.command.token.incarnation,
									frame.bytes,
								)
							: frame._tag === "StdioClose"
								? bridge.close(
										handle.command.unit,
										handle.command.token.incarnation,
									)
								: bridge.release(
										handle.command.unit,
										handle.command.token.incarnation,
									),
				})
				return
			/** The channel, not the frame, names the unit incarnation that registers or acknowledges. */
			case "RecorderRegister":
				yield* Queue.offer(runtime.events, {
					_tag: "RecorderRegistered",
					unit: handle.command.unit,
					incarnation: handle.command.token.incarnation,
					recorder: frame.recorder,
				})
				return
			case "RecordAck":
				yield* Queue.offer(runtime.events, {
					_tag: "RecordAcknowledged",
					unit: handle.command.unit,
					incarnation: handle.command.token.incarnation,
					record: frame.record,
					content: frame.content,
				})
				return
			case "Diagnostic":
			case "Failure": {
				const cause = yield* Schema.decodeEffect(Wire.Cause)(frame.cause)
				yield* Queue.offer(runtime.events, {
					_tag: frame._tag === "Diagnostic" ? "UnitDiagnostic" : "UnitFailed",
					...unitEvent(handle.command),
					cause,
				})
				return
			}
			case "Cleanup": {
				const cause =
					frame.cause === undefined
						? Cause.empty
						: yield* Schema.decodeEffect(Wire.Cause)(frame.cause)
				yield* Queue.offer(runtime.events, {
					_tag: "UnitCleanup",
					...unitEvent(handle.command),
					cause,
					cleanup:
						frame.cause === undefined
							? { _tag: "Completed" }
							: { _tag: "Failed", cause },
				})
				return
			}
			case "Result": {
				const pending = yield* Ref.get(handle.pending)
				const waiter = HashMap.get(pending, frame.command)
				const report = yield* decodeReport(frame.result)
				if (Option.isSome(waiter)) yield* Deferred.succeed(waiter.value, report)
				yield* Ref.update(handle.pending, HashMap.remove(frame.command))
			}
		}
	},
	(effect, runtime: Runtime, handle: Handle) =>
		effect.pipe(
			Effect.catchCause((cause) =>
				Queue.offer(runtime.events, {
					_tag: "UnitFailed",
					...unitEvent(handle.command),
					cause,
				}).pipe(Effect.asVoid),
			),
		),
)
const exited = Effect.fnUntraced(function* (
	runtime: Runtime,
	handle: Handle,
	cause: Cause.Cause<unknown>,
) {
	yield* Deferred.succeed(handle.ended, undefined)
	yield* Queue.offer(runtime.events, {
		_tag: "Exited",
		...unitEvent(handle.command),
		cleanup: { _tag: "Unknown" },
		cause,
	})
	const pending = yield* Ref.get(handle.pending)
	yield* Effect.forEach(
		HashMap.values(pending),
		(waiter) =>
			Deferred.succeed(waiter, {
				...failed(cause),
				_tag: "Failed",
				cause,
				creation: "Unknown",
				delivery: "Unavailable",
			}),
		{ discard: true },
	)
	yield* Ref.set(handle.pending, HashMap.empty())
	yield* Ref.update(
		runtime.handles,
		HashMap.remove(handle.command.token.incarnation),
	)
})
const disconnected = (
	runtime: Runtime,
	handle: Handle,
	cause: Cause.Cause<unknown>,
) =>
	Queue.offer(runtime.events, {
		_tag: "UnitDisconnected",
		...unitEvent(handle.command),
		cause,
	}).pipe(Effect.asVoid)
const launcher = Effect.sync(
	() => new URL(import.meta.resolve("@graftland/plugin-remote/internal/unit")),
)
const base = Effect.fnUntraced(function* (command: Command) {
	return {
		command,
		online: yield* Deferred.make<void>(),
		initialized: yield* Deferred.make<void>(),
		ended: yield* Deferred.make<void>(),
		pending: yield* Ref.make(
			HashMap.empty<string, Deferred.Deferred<Report>>(),
		),
	}
})
const worker = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Command,
) {
	const state = yield* base(command)
	const script = yield* launcher
	const native = yield* Effect.try({
		try: () => new Worker(script, { execArgv: [] }),
		catch: (cause) => NativeFailure.make({ cause: Cause.die(cause) }),
	}).pipe(Effect.orDie)
	const handle: Handle = {
		...state,
		send: (message) =>
			Wire.encodeIncoming(message).pipe(
				Effect.orDie,
				Effect.flatMap((encoded) =>
					Effect.sync(() => native.postMessage(encoded)),
				),
			),
		terminate: Effect.sync(() => {
			native.terminate().then(
				() => undefined,
				(error) => {
					runtime.run(
						Queue.offer(runtime.events, {
							_tag: "UnitFailed",
							...unitEvent(command),
							cause: Cause.die(error),
						}).pipe(Effect.asVoid),
					)
				},
			)
		}),
	}
	native.on("message", (value) => runtime.run(message(runtime, handle, value)))
	native.on("error", (error) =>
		runtime.run(
			Queue.offer(runtime.events, {
				_tag: "UnitFailed",
				...unitEvent(command),
				cause: Cause.die(error),
			}).pipe(Effect.asVoid),
		),
	)
	native.once("exit", (code) =>
		runtime.run(
			exited(
				runtime,
				handle,
				code === 0 ? Cause.empty : Cause.fail({ exitCode: code }),
			),
		),
	)
	return handle
})
const child = Effect.fnUntraced(function* (runtime: Runtime, command: Command) {
	const state = yield* base(command)
	const script = yield* launcher
	const native: ChildProcess = yield* Effect.try({
		try: () =>
			spawn(process.execPath, [fileURLToPath(script)], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			}),
		catch: (cause) => NativeFailure.make({ cause: Cause.die(cause) }),
	}).pipe(Effect.orDie)
	const handle: Handle = {
		...state,
		send: (message) =>
			Wire.encodeIncoming(message).pipe(
				Effect.orDie,
				Effect.flatMap((encoded) =>
					Effect.callback<void>((resume) => {
						if (!native.connected) {
							resume(Effect.die("Native unit control is disconnected"))
							return
						}
						native.send(encoded, (error) =>
							resume(error === null ? Effect.void : Effect.die(error)),
						)
					}),
				),
			),
		terminate: Effect.sync(() => {
			native.kill("SIGKILL")
		}),
	}
	native.on("message", (value) => runtime.run(message(runtime, handle, value)))
	native.on("disconnect", () =>
		runtime.run(
			disconnected(runtime, handle, Cause.fail("Native control disconnected")),
		),
	)
	native.on("error", (error) =>
		runtime.run(
			Queue.offer(runtime.events, {
				_tag: "UnitFailed",
				...unitEvent(command),
				cause: Cause.die(error),
			}).pipe(Effect.asVoid),
		),
	)
	native.stderr?.on("data", (data) =>
		runtime.run(
			Queue.offer(runtime.events, {
				_tag: "UnitDiagnostic",
				...unitEvent(command),
				cause: Cause.fail({ diagnostic: globalThis.String(data) }),
			}).pipe(Effect.asVoid),
		),
	)
	native.once("exit", (code, signal) =>
		runtime.run(
			exited(
				runtime,
				handle,
				code === 0 ? Cause.empty : Cause.fail({ exitCode: code, signal }),
			),
		),
	)
	return handle
})
const prevent = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Command,
) {
	yield* Ref.update(runtime.prevented, HashSet.add(command.token.incarnation))
	const handle = yield* Ref.get(runtime.handles).pipe(
		Effect.map((handles) => HashMap.get(handles, command.token.incarnation)),
	)
	if (Option.isSome(handle)) yield* handle.value.terminate
})
const create = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Command,
): Effect.fn.Return<Report> {
	if (command.target.deployment === undefined)
		return failed(
			Cause.fail("Native deployment data is required"),
			"NotStarted",
		)
	const size = yield* Effect.exit(EncodedLimit.check(command))
	if (Exit.isFailure(size)) {
		const existing = yield* Ref.get(runtime.handles)
		return failed(
			size.cause,
			HashMap.has(existing, command.token.incarnation)
				? "Unknown"
				: "NotStarted",
		)
	}
	const prevented = yield* Ref.get(runtime.prevented)
	if (HashSet.has(prevented, command.token.incarnation))
		return failed(Cause.fail("Spawn was prevented"), "NotStarted")
	const handle = yield* Effect.uninterruptible(
		Effect.gen(function* () {
			const known = yield* Ref.get(runtime.handles).pipe(
				Effect.map((handles) =>
					HashMap.get(handles, command.token.incarnation),
				),
			)
			if (Option.isSome(known)) return known.value
			const created = yield* command.placement.kind === "Worker"
				? worker(runtime, command)
				: child(runtime, command)
			yield* Ref.update(
				runtime.handles,
				HashMap.set(command.token.incarnation, created),
			)
			return created
		}),
	)
	const stopped = yield* Ref.get(runtime.prevented)
	if (HashSet.has(stopped, command.token.incarnation)) yield* handle.terminate
	yield* Deferred.await(handle.online).pipe(
		Effect.raceFirst(
			Deferred.await(handle.ended).pipe(
				Effect.andThen(Effect.die("Unit exited during bootstrap")),
			),
		),
	)
	const encoded = yield* Schema.decodeEffect(Schema.toType(Wire.Command))(
		command,
	).pipe(Effect.orDie)
	yield* handle.send({ _tag: "Init", command: encoded })
	yield* Deferred.await(handle.initialized).pipe(
		Effect.raceFirst(
			Deferred.await(handle.ended).pipe(
				Effect.andThen(Effect.die("Unit exited before initialization")),
			),
		),
	)
	return { _tag: "Succeeded" }
})
const request = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Command,
): Effect.fn.Return<Report> {
	const handle = yield* Ref.get(runtime.handles).pipe(
		Effect.map((handles) => HashMap.get(handles, command.token.incarnation)),
	)
	if (Option.isNone(handle))
		return failed(Cause.fail("Native incarnation is unavailable"))
	const reply = yield* Deferred.make<Report>()
	yield* Ref.update(handle.value.pending, HashMap.set(command.id, reply))
	const encoded = yield* Schema.decodeEffect(Schema.toType(Wire.Command))(
		command,
	).pipe(Effect.orDie)
	yield* handle.value.send({ _tag: "Run", command: encoded })
	return yield* Deferred.await(reply)
})
const send = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Command,
): Effect.fn.Return<
	Report,
	Resolution.ResolutionFailed | Schema.SchemaError,
	Digest.Digest
> {
	switch (command.kind) {
		case "Resolve":
			return { _tag: "Resolved", value: yield* Resolution.resolve(command) }
		case "Spawn":
			return yield* create(runtime, command)
		case "Terminate":
			yield* prevent(runtime, command)
			return { _tag: "Succeeded" }
		default:
			return yield* request(runtime, command)
	}
})
const placementLayer = (withRunner: boolean) =>
	Layer.effect(
		UnitControl,
		Effect.gen(function* () {
			const digest = yield* Digest.Digest
			const callbacks = yield* FiberSet.make<void, never>()
			const run = yield* FiberSet.runtime(callbacks)()
			const runtime: Runtime = {
				scope: yield* Effect.scope,
				handles: yield* Ref.make(HashMap.empty<string, Handle>()),
				prevented: yield* Ref.make(HashSet.empty<string>()),
				requests: yield* Queue.bounded<UnitEvent>(128),
				events: yield* Queue.bounded<UnitEvent>(256),
				callbacks,
				run,
				stdio: yield* Bridge.StdioBridge,
			}
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					const handles = yield* Ref.get(runtime.handles)
					yield* Effect.forEach(
						HashMap.values(handles),
						(handle) =>
							handle.terminate.pipe(
								Effect.catchCause((cause) =>
									Queue.offer(runtime.events, {
										_tag: "UnitFailed",
										...unitEvent(handle.command),
										cause,
									}),
								),
								Effect.asVoid,
							),
						{ discard: true },
					)
				}),
			)
			const runner = yield* RunnerClient.make((event) =>
				Queue.offer(
					event._tag === "CallObserved" && event.message._tag === "Request"
						? runtime.requests
						: runtime.events,
					event,
				).pipe(Effect.asVoid),
			)
			return UnitControl.of({
				events: Stream.merge(
					Stream.fromQueue(runtime.events),
					Stream.fromQueue(runtime.requests),
				),
				send: (command) =>
					(withRunner &&
					command.placement.kind === "Runner" &&
					command.kind !== "Resolve"
						? runner(command)
						: send(runtime, command)
					).pipe(
						Effect.provideService(Digest.Digest, digest),
						Effect.exit,
						Effect.map((exit) =>
							Exit.isSuccess(exit) ? exit.value : failed(exit.cause),
						),
					),
			})
		}),
	).pipe(Layer.provide(Digest.layerWebCrypto))

export const localLayer = placementLayer(false)
export const layer = placementLayer(true)
