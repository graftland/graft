import { createServer, type Socket } from "node:net"

import {
	Cause,
	Deferred,
	Effect,
	Exit,
	FiberMap,
	FiberSet,
	HashSet,
	Option,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"
import { make as secureRandom } from "effect/crypto/SecureRandom"
import { WebCrypto } from "effect/crypto/WebCrypto"

import * as Kernel from "@graftland/graft/Kernel"

import * as Wire from "./controlProtocol"
import * as Limit from "./encodedLimit"
import * as Lines from "./jsonLines"

interface Session {
	readonly kernel: Kernel.Kernel["Service"]
	readonly token: string
	readonly socket: Socket
	readonly replies: Queue.Queue<Wire.Outgoing>
	readonly notices: Queue.Queue<Wire.Outgoing>
	readonly requests: FiberMap.FiberMap<string, void, never>
	readonly watch: FiberMap.FiberMap<string, void, never>
	readonly active: Ref.Ref<HashSet.HashSet<string>>
}
const failure = (
	reason: string,
	cause: Cause.Cause<unknown>,
): Wire.Response => ({ _tag: "Failure", reason, cause, conflicts: [] })
const execute = Effect.fnUntraced(function* (
	kernel: Kernel.Kernel["Service"],
	request: Wire.Request,
): Effect.fn.Return<
	Wire.Response,
	Kernel.ChangeRejected | Kernel.UnknownChange
> {
	switch (request._tag) {
		case "Ping":
			return { _tag: "Ack" }
		case "Submit":
			return { _tag: "Submitted", id: (yield* kernel.submit(request.input)).id }
		case "Get":
			return { _tag: "Status", value: yield* kernel.get(request.id) }
		case "Await":
			return { _tag: "Outcome", value: yield* kernel.await(request.id) }
		case "Cancel":
			yield* kernel.cancel(request.id)
			return { _tag: "Ack" }
		case "Inspect": {
			const description = yield* kernel.inspect(request.input)
			return {
				_tag: "Preparation",
				value: Option.some(description),
			}
		}
		case "GetPreparation":
			return {
				_tag: "Preparation",
				value: yield* kernel.getPreparation(request.id),
			}
		case "Units":
			return { _tag: "Units", value: yield* kernel.units }
		case "Preparations":
			return { _tag: "Preparations", value: yield* kernel.inspections }
		case "Waiters":
			return { _tag: "Waiters", value: yield* kernel.waiters }
		case "Calls":
			return { _tag: "Calls", value: yield* kernel.calls }
		case "SetPolicy":
			yield* kernel.setPolicy(request.policy)
			return { _tag: "Ack" }
		case "Shutdown":
			yield* kernel.shutdown
			return { _tag: "Ack" }
	}
})
const response = (
	exit: Exit.Exit<Wire.Response, Kernel.ChangeRejected | Kernel.UnknownChange>,
): Wire.Response => {
	if (Exit.isSuccess(exit)) return exit.value
	const error = Cause.findErrorOption(exit.cause)
	if (Option.isSome(error) && Schema.is(Kernel.ChangeRejected)(error.value))
		return {
			_tag: "Failure",
			reason: error.value.reason,
			cause: Cause.combine(exit.cause, error.value.cause ?? Cause.empty),
			conflicts: error.value.conflicts,
			...(error.value.preparation === undefined
				? {}
				: { preparation: error.value.preparation }),
		}
	return failure(
		Option.isSome(error) && Schema.is(Kernel.UnknownChange)(error.value)
			? "NotFound"
			: "Failed",
		exit.cause,
	)
}
const reply = (s: Session, id: string, result: Wire.Response) =>
	Queue.offer(s.replies, { _tag: "Reply", id, result }).pipe(Effect.asVoid)
const notice = (s: Session, value: Wire.Outgoing) =>
	Queue.offer(s.notices, value).pipe(Effect.asVoid)
const watch = Effect.fnUntraced(function* (s: Session) {
	yield* FiberMap.run(
		s.watch,
		"changes",
		Stream.runForEach(s.kernel.changes, (value) =>
			notice(s, { _tag: "Change", value }),
		),
		{ onlyIfMissing: true },
	)
	yield* FiberMap.run(
		s.watch,
		"preparations",
		Stream.runForEach(s.kernel.preparations, (value) =>
			notice(s, { _tag: "Preparation", value }),
		),
		{ onlyIfMissing: true },
	)
	yield* FiberMap.run(
		s.watch,
		"calls",
		Stream.runForEach(s.kernel.callChanges, (value) =>
			notice(s, { _tag: "Call", value }),
		),
		{ onlyIfMissing: true },
	)
})
const dispatch = Effect.fnUntraced(function* (
	s: Session,
	frame: Wire.Incoming,
) {
	if (frame.token !== s.token)
		return yield* reply(
			s,
			frame.id,
			failure(
				"Unauthorized",
				Cause.fail("The control capability does not match"),
			),
		)
	yield* watch(s)
	const admitted = yield* Ref.modify(s.active, (active) =>
		HashSet.size(active) >= 64 || HashSet.has(active, frame.id)
			? [false, active]
			: [true, HashSet.add(active, frame.id)],
	)
	if (!admitted)
		return yield* reply(
			s,
			frame.id,
			failure(
				"Saturated",
				Cause.fail("The control connection request limit is full"),
			),
		)
	yield* FiberMap.run(
		s.requests,
		frame.id,
		Effect.exit(execute(s.kernel, frame.request)).pipe(
			Effect.flatMap((exit) => reply(s, frame.id, response(exit))),
			Effect.ensuring(Ref.update(s.active, HashSet.remove(frame.id))),
		),
		{ onlyIfMissing: true },
	)
})
const write = (socket: Socket, frame: Wire.Outgoing) =>
	Wire.encodeResponse(frame).pipe(
		Effect.flatMap((line) =>
			Limit.check(frame).pipe(Effect.andThen(Lines.write(socket, line))),
		),
		Effect.orDie,
	)
const session = Effect.fnUntraced(function* (
	kernel: Kernel.Kernel["Service"],
	token: string,
	socket: Socket,
) {
	const s: Session = {
		kernel,
		token,
		socket,
		replies: yield* Queue.bounded<Wire.Outgoing>(128),
		notices: yield* Queue.sliding<Wire.Outgoing>(64),
		requests: yield* FiberMap.make<string, void, never>(),
		watch: yield* FiberMap.make<string, void, never>(),
		active: yield* Ref.make(HashSet.empty<string>()),
	}
	yield* Stream.merge(
		Stream.fromQueue(s.replies),
		Stream.fromQueue(s.notices),
	).pipe(
		Stream.runForEach((frame) => write(socket, frame)),
		Effect.forkScoped,
	)
	const incoming = yield* Lines.receive(socket)
	yield* Stream.runForEach(incoming, (line) =>
		Wire.decodeRequest(line).pipe(
			Effect.flatMap((frame) => dispatch(s, frame)),
		),
	)
}, Effect.scoped)
/** Opens a local capability-protected control endpoint. */
export const serve = Effect.fnUntraced(function* (): Effect.fn.Return<
	Wire.Address,
	Wire.ControlError,
	Scope.Scope | Kernel.Kernel
> {
	const kernel = yield* Kernel.Kernel
	const token = yield* WebCrypto.use((crypto) =>
		secureRandom((size) =>
			crypto.getRandomValues(new Uint8Array(size)),
		).uuidV4(),
	)
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const ready = yield* Deferred.make<void, Wire.ControlError>()
	const server = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createServer((socket) =>
				run(
					session(kernel, token, socket).pipe(
						Effect.catchCause((cause) =>
							Effect.logDebug("Control connection ended", cause),
						),
					),
				),
			),
		),
		(server) =>
			Effect.sync(() => {
				server.close()
			}),
	)
	yield* Effect.sync(() => {
		server.on("error", (error) =>
			run(
				Deferred.fail(
					ready,
					Wire.ControlError.make({ reason: "Listen", cause: Cause.die(error) }),
				).pipe(
					Effect.andThen(Effect.logError("Control listener failed", error)),
				),
			),
		)
		server.listen({ host: "127.0.0.1", port: 0 }, () =>
			run(Deferred.succeed(ready, undefined)),
		)
	})
	yield* Deferred.await(ready)
	const address = yield* Effect.sync(() => server.address())
	if (address === null || typeof address === "string")
		return yield* Wire.ControlError.make({
			reason: "Listen",
			cause: Cause.fail("Control listener has no TCP address"),
		})
	return { host: "127.0.0.1", port: address.port, token }
})
