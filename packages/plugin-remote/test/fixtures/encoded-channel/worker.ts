import { MessagePort, workerData } from "node:worker_threads"

import {
	Cause,
	Deferred,
	Effect,
	Exit,
	FiberMap,
	HashMap,
	Option,
	Queue,
	Ref,
	Schema,
} from "effect"
import {
	RpcClient,
	RpcClientError,
	RpcMessage,
	RpcSerialization,
	RpcServer,
} from "effect/rpc"

import { Input, makeContract, Rejected } from "./contract"
import { Command, inbox, Request, Response, type Event } from "./wire"

const Config = Schema.Struct({
	role: Schema.Literals(["consumer", "provider"]),
	control: Schema.instanceOf(MessagePort),
	tag: Schema.String,
	build: Schema.String,
})
type Route = Extract<Command, { _tag: "Bind" }>
type Contract = ReturnType<typeof makeContract>
type Emit = (event: Event) => Effect.Effect<void>

const serve = Effect.fnUntraced(function* (
	route: Route,
	contract: Contract,
	emit: Emit,
	release: Deferred.Deferred<void>,
) {
	const input = yield* inbox(route.port)
	const disconnects = yield* Queue.unbounded<number>()
	const serialization = yield* RpcSerialization.RpcSerialization
	const protocol = RpcServer.Protocol.of({
		run: (write) =>
			Queue.take(input).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Request)),
				Effect.orDie,
				Effect.flatMap((message) => write(0, message)),
				Effect.forever,
			),
		disconnects,
		send: (_, message) =>
			Effect.sync(() => route.port.postMessage(message)).pipe(
				Effect.andThen(
					message._tag === "Exit"
						? emit({ phase: "exit-sent", id: String(message.requestId) })
						: Effect.void,
				),
			),
		end: () => Effect.void,
		clientIds: Effect.succeed(new Set([0])),
		initialMessage: Effect.succeedNone,
		supportsAck: true,
		supportsTransferables: false,
		supportsSpanPropagation: false,
		supportsNotifications: false,
		codecFor: serialization.codecFor,
	})
	const cleanup = (id: string) =>
		emit({ phase: "cleanup-started", id }).pipe(
			Effect.andThen(Deferred.await(release)),
			Effect.andThen(emit({ phase: "cleanup-finished", id })),
		)
	const handlers = contract.group.toLayer({
		[contract.declaration.tag]: Effect.fnUntraced(function* ({
			id,
			mode,
			at,
		}: typeof Input.Type) {
			yield* emit({ phase: "started", id, checked: at instanceof Date })
			switch (mode) {
				case "success":
					return at
				case "error":
					return yield* Rejected.make({
						reason: "The fixture rejected the request",
						at,
					})
				case "ensuring":
					return yield* Effect.never.pipe(Effect.ensuring(cleanup(id)))
				case "scope":
					yield* Effect.addFinalizer(() => cleanup(id))
					return yield* Effect.never
				case "scope-success":
					yield* Effect.addFinalizer(() => cleanup(id))
					return at
			}
		}),
	})
	return yield* RpcServer.make(contract.group, { disableTracing: true }).pipe(
		Effect.provide(handlers),
		Effect.provideService(RpcServer.Protocol, protocol),
	)
})

const portClosed = (port: MessagePort) =>
	Effect.callback<void>((resume) => {
		const close = () => resume(Effect.void)
		port.on("close", close)
		return Effect.sync(() => {
			port.off("close", close)
		})
	})

// A fresh client per invocation keeps test request ids explicit. Production
// should reuse a client per endpoint and include its session in the ticket key.
const call = Effect.fnUntraced(function* (
	route: Route,
	contract: Contract,
	command: Extract<Command, { _tag: "Call" }>,
	emit: Emit,
) {
	const input = yield* inbox(route.port)
	const serialization = yield* RpcSerialization.RpcSerialization
	const disconnected = RpcClientError.RpcClientError.make({
		reason: RpcClientError.RpcClientDefect.make({
			message: "Provider channel closed",
			cause: Cause.die("MessagePort closed"),
		}),
	})
	const protocol = RpcClient.Protocol.of({
		run: (_, write) =>
			Queue.take(input).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Response)),
				Effect.orDie,
				Effect.flatMap(write),
				Effect.forever,
				Effect.raceFirst(
					portClosed(route.port).pipe(
						Effect.andThen(() =>
							write({
								_tag: "ClientProtocolError",
								error: disconnected,
								requestIds: [command.id],
							}),
						),
						Effect.andThen(Effect.never),
					),
				),
			),
		send: (_, message) =>
			Effect.sync(() => route.port.postMessage(message)).pipe(
				Effect.andThen(
					message._tag === "Request"
						? emit({
								phase: "dispatched",
								id: command.id,
								checked:
									message.tag === contract.declaration.tag &&
									typeof message.payload === "object" &&
									message.payload !== null &&
									"at" in message.payload &&
									typeof message.payload.at === "string",
							})
						: Effect.void,
				),
			),
		supportsAck: true,
		supportsTransferables: false,
		codecFor: serialization.codecFor,
	})
	const client = yield* RpcClient.make(contract.group, {
		disableTracing: true,
		flatten: true,
		generateRequestId: () => RpcMessage.RequestId(command.id),
	}).pipe(Effect.provideService(RpcClient.Protocol, protocol))
	const at = yield* Schema.decodeEffect(Schema.DateFromString)(
		"2026-11-07T00:00:00.000Z",
	)
	yield* client(contract.declaration.tag, {
		id: command.id,
		mode: command.mode,
		at,
	}).pipe(
		Effect.matchEffect({
			onSuccess: (value) =>
				emit({
					phase: "success",
					id: command.id,
					checked: value instanceof Date && value.getTime() === at.getTime(),
				}),
			onFailure: Effect.fnUntraced(function* (error) {
				if (error._tag === "RpcClientError") {
					const diagnostic = yield* Schema.encodeEffect(
						Schema.toCodecJson(RpcClientError.RpcClientError),
					)(error)
					return yield* emit({ phase: "unknown", id: command.id, diagnostic })
				}
				yield* emit({
					phase: "error",
					id: command.id,
					checked:
						Schema.is(Rejected)(error) &&
						Object.getPrototypeOf(error) === Rejected.prototype &&
						error.reason === "The fixture rejected the request" &&
						error.at instanceof Date &&
						error.at.getTime() === at.getTime(),
				})
			}),
		}),
	)
}, Effect.scoped)

export const main = Effect.gen(function* () {
	const config = yield* Schema.decodeUnknownEffect(Config)(workerData)
	const commands = yield* inbox(config.control)
	const emit = (event: Event) =>
		Effect.sync(() => config.control.postMessage(event))
	const contract = makeContract(config.tag, config.build)
	const release = yield* Deferred.make<void>()
	const calls = yield* FiberMap.make<string, void, Schema.SchemaError>()
	const routes = yield* Ref.make(HashMap.empty<string, Route>())
	yield* emit({ phase: "ready", id: "", declaration: contract.declaration })
	return yield* Queue.take(commands).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Command)),
		Effect.flatMap(
			Effect.fnUntraced(function* (command) {
				switch (command._tag) {
					case "Bind":
						yield* Ref.update(routes, HashMap.set(command.generation, command))
						if (config.role === "provider") {
							yield* FiberMap.run(
								calls,
								`server/${command.generation}`,
								serve(command, contract, emit, release),
								{ startImmediately: true },
							)
						}
						return yield* emit({ phase: "bound", id: command.generation })
					case "Release":
						return yield* Deferred.succeed(release, undefined)
					case "Barrier":
						return yield* emit({ phase: "barrier", id: "" })
					case "Cancel":
						return yield* FiberMap.remove(calls, command.id)
					case "Call": {
						const current = yield* Ref.get(routes)
						const route = HashMap.get(current, command.generation)
						if (Option.isNone(route))
							return yield* Effect.die("Unknown route generation")
						yield* FiberMap.run(
							calls,
							command.id,
							call(route.value, contract, command, emit).pipe(
								Effect.onExit((exit) =>
									emit({
										phase: "client-stopped",
										id: command.id,
										checked:
											Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause),
									}),
								),
							),
						)
						return
					}
				}
			}),
		),
		Effect.forever,
		Effect.raceFirst(FiberMap.join(calls)),
	)
}).pipe(Effect.scoped, Effect.provide(RpcSerialization.layerJson))

// The bootstrap calls run explicitly; importing this module does no I/O.
export const run = () => Effect.runPromise(main)
