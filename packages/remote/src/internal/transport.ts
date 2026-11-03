import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Queue,
	Ref,
	Schema,
	Stream,
	String,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc"
import { ProcessExited, TransportError } from "../Errors"

const Id = Schema.Union([Schema.String, Schema.Finite])
const Reason = Schema.Union([
	Schema.TaggedStruct("Fail", { error: Schema.Unknown }),
	Schema.TaggedStruct("Die", { defect: Schema.Unknown }),
	Schema.TaggedStruct("Interrupt", {
		fiberId: Schema.UndefinedOr(Schema.NullOr(Schema.Finite)),
	}),
])
const Response = Schema.Union([
	Schema.TaggedStruct("Exit", {
		requestId: Id,
		exit: Schema.Union([
			Schema.TaggedStruct("Success", { value: Schema.Unknown }),
			Schema.TaggedStruct("Failure", { cause: Schema.Array(Reason) }),
		]),
	}),
	Schema.TaggedStruct("Chunk", {
		requestId: Id,
		values: Schema.NonEmptyArray(Schema.Unknown),
	}),
	Schema.TaggedStruct("Defect", { defect: Schema.Unknown }),
	Schema.TaggedStruct("Pong", {}),
])

/** One client and one process per activation; EOF is resolved by the exit observer. */
export const make = Effect.fnUntraced(function* (
	child: ChildProcessSpawner.ChildProcessHandle,
) {
	const failed = yield* Deferred.make<never, ProcessExited | TransportError>()
	const stopping = yield* Ref.make(false)
	const failures = yield* Ref.make<Cause.Cause<ProcessExited | TransportError>>(
		Cause.empty,
	)
	const outgoing = yield* Queue.bounded<Uint8Array, Cause.Done>(32)
	const stderr = yield* Ref.make("")
	const record = (error: ProcessExited | TransportError) =>
		Effect.gen(function* () {
			yield* Ref.update(failures, (cause) =>
				Cause.combine(cause, Cause.fail(error)),
			)
			yield* Deferred.fail(failed, error)
		})
	const report = (cause: Cause.Cause<unknown>) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.void
			: record(TransportError.make({ cause }))
	const stderrFiber = yield* child.stderr.pipe(
		Stream.decodeText(),
		Stream.runForEach((text) =>
			Ref.update(stderr, (tail) => String.takeRight(tail + text, 8192)),
		),
		Effect.tapCause(report),
		Effect.forkScoped,
	)
	const stdoutFiber = yield* child.stdout.pipe(
		Stream.runDrain,
		Effect.tapCause(report),
		Effect.forkScoped,
	)
	const writer = yield* Stream.fromQueue(outgoing).pipe(
		Stream.run(child.stdin),
		Effect.tapCause(report),
		Effect.forkScoped,
	)
	const exited = yield* Effect.gen(function* () {
		const status = yield* Effect.exit(child.exitCode)
		const err = yield* Fiber.await(stderrFiber)
		const out = yield* Fiber.await(stdoutFiber)
		const empty: Cause.Cause<unknown> = Cause.empty
		const statusCause = Array.reduce(
			[Exit.asVoid(status), err, out],
			empty,
			(cause, exit) =>
				Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause,
		)
		const error = ProcessExited.make({
			pid: child.pid,
			exitCode: Exit.isSuccess(status) ? status.value : null,
			stderr: yield* Ref.get(stderr),
			statusCause,
		})
		if (!(yield* Ref.get(stopping))) yield* record(error)
		return error
	}).pipe(Effect.forkScoped)
	const parser = RpcSerialization.makeNdjson({
		maxBufferSize: 1024 * 1024,
	}).makeUnsafe()
	const protocol = RpcClient.Protocol.of({
		codecFor: RpcSerialization.json.codecFor,
		supportsAck: true,
		supportsTransferables: false,
		run: (_id, receive) =>
			child.getOutputFd(3).pipe(
				Stream.runForEach((bytes) =>
					Effect.gen(function* () {
						const messages = yield* Effect.try({
							try: () => parser.decode(bytes),
							catch: (error) =>
								TransportError.make({ cause: Cause.die(error) }),
						}).pipe(Effect.orDie)
						for (const message of messages) {
							const decoded =
								yield* Schema.decodeUnknownEffect(Response)(message)
							yield* receive(decoded)
						}
					}),
				),
				Effect.catchCause((cause) => Effect.asVoid(report(cause))),
				Effect.andThen(Effect.never),
			),
		send: (_id, message) =>
			Effect.gen(function* () {
				const encoded = yield* Effect.try({
					try: () => parser.encode(message),
					catch: (cause) =>
						RpcClientError.RpcClientError.make({
							reason: RpcClientError.RpcClientDefect.make({
								message: "Could not encode a control message",
								cause,
							}),
						}),
				})
				if (encoded !== undefined)
					yield* Queue.offer(
						outgoing,
						typeof encoded === "string"
							? new TextEncoder().encode(encoded)
							: encoded,
					)
			}),
	})
	return {
		protocol,
		report,
		failures,
		failed,
		stopping,
		exited,
		end: Queue.end(outgoing).pipe(Effect.andThen(Fiber.join(writer))),
	}
})
