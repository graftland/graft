/** Owns only the Graft-supplied single-hop handler Scope, independently of RpcServer's private Scope. */
import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberMap,
	HashMap,
	Option,
	Queue,
	Ref,
	Scope,
	Stream,
} from "effect"

import * as Frames from "./callFrames"
import type * as Wire from "./unitProtocol"

export const SingleHop = Context.Reference<boolean>(
	"@graftland/plugin-remote/internal/ownedCalls/SingleHop",
	{ defaultValue: () => false },
)
interface Registered {
	readonly grant: Wire.CallControl
	readonly started: boolean
	readonly cancelled: boolean
	readonly completion: Option.Option<Wire.CallMessage>
}
interface Runtime {
	readonly errors: Queue.Queue<Cause.Cause<unknown>>
	readonly scope: Scope.Scope
	readonly records: Ref.Ref<HashMap.HashMap<string, Registered>>
	readonly fibers: FiberMap.FiberMap<string, void, never>
	readonly emit: (message: Wire.CallMessage) => Effect.Effect<void>
}
export interface Owner {
	readonly failures: Stream.Stream<Cause.Cause<unknown>>
	readonly register: (grant: Wire.CallControl) => Effect.Effect<void>
	readonly cancel: (key: string) => Effect.Effect<void>
	readonly ack: (key: string) => Effect.Effect<void>
	readonly reconcile: Effect.Effect<void>
	readonly pending: Effect.Effect<number>
	readonly run: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
		ticket: string,
		tag: string,
	) => Effect.Effect<A, E, R>
}
const retain = Effect.fnUntraced(function* (
	runtime: Runtime,
	key: string,
	cause: Cause.Cause<unknown>,
	cleanup: Exit.Exit<void, never>,
) {
	const message = yield* Frames.encode({
		_tag: "Complete",
		key,
		cause,
		cleanup: Exit.isSuccess(cleanup)
			? { _tag: "Completed" }
			: { _tag: "Failed", cause: cleanup.cause },
	}).pipe(Effect.orDie)
	yield* Ref.update(
		runtime.records,
		HashMap.modify(key, (r) => ({ ...r, completion: Option.some(message) })),
	)
	yield* runtime.emit(message)
})
const execute = <A, E, R>(
	runtime: Runtime,
	effect: Effect.Effect<A, E, R>,
	ticket: string,
	scope: Scope.Closeable,
	result: Deferred.Deferred<A, E>,
): Effect.Effect<void, never, R> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const revoked = yield* Ref.get(runtime.records).pipe(
				Effect.map((records) =>
					Option.exists(HashMap.get(records, ticket), (r) => r.cancelled),
				),
			)
			const business = yield* Effect.exit(
				revoked
					? Effect.interrupt
					: restore(
							effect.pipe(
								Scope.provide(scope),
								Effect.provideService(SingleHop, true),
							),
						),
			)
			const exit: Exit.Exit<A, E> =
				Exit.isSuccess(business) && Deferred.isDeferred(business.value)
					? Exit.die(
							new Error("Deferred replies are not supported by unit contracts"),
						)
					: business
			yield* Deferred.done(result, exit)
			const closed = yield* Effect.exit(Scope.close(scope, exit))
			yield* retain(
				runtime,
				ticket,
				Cause.combine(
					Exit.isFailure(exit) ? exit.cause : Cause.empty,
					Exit.isFailure(closed) ? closed.cause : Cause.empty,
				),
				closed,
			)
		}),
	).pipe(
		Effect.catchCause((cause) =>
			Queue.offer(runtime.errors, cause).pipe(Effect.asVoid),
		),
	)
const run = <A, E, R>(
	runtime: Runtime,
	effect: Effect.Effect<A, E, R>,
	ticket: string,
	tag: string,
): Effect.Effect<A, E, R> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const accepted = yield* Ref.modify(runtime.records, (records) => {
				const known = HashMap.get(records, ticket)
				if (
					Option.isNone(known) ||
					known.value.started ||
					known.value.cancelled ||
					!Array.contains(known.value.grant.tags ?? [], tag)
				)
					return [false, records]
				return [
					true,
					HashMap.set(records, ticket, { ...known.value, started: true }),
				]
			})
			if (!accepted)
				return yield* Effect.die(
					"The call has no unused core authorization for this operation",
				)
			const scope = yield* Scope.make()
			const result = yield* Deferred.make<A, E>()
			yield* FiberMap.run(
				runtime.fibers,
				ticket,
				execute(runtime, effect, ticket, scope, result).pipe(
					Effect.interruptible,
				),
				{ onlyIfMissing: true, startImmediately: false },
			)
			return yield* restore(Deferred.await(result)).pipe(
				Effect.onInterrupt(() => cancel(runtime, ticket)),
			)
		}),
	)
const cancel = Effect.fnUntraced(function* (runtime: Runtime, key: string) {
	const known = yield* Ref.modify(runtime.records, (records) => [
		HashMap.get(records, key),
		HashMap.set(records, key, {
			...Option.getOrElse(HashMap.get(records, key), () => ({
				grant: { key, session: "", request: "", service: "" },
				started: false,
				cancelled: true,
				completion: Option.none<Wire.CallMessage>(),
			})),
			cancelled: true,
		}),
	])
	if (Option.isNone(known))
		return yield* retain(runtime, key, Cause.empty, Exit.void)
	if (!known.value.started && Option.isNone(known.value.completion))
		return yield* retain(runtime, key, Cause.empty, Exit.void)
	const fiber = yield* FiberMap.get(runtime.fibers, key)
	if (Option.isSome(fiber))
		yield* Fiber.interrupt(fiber.value).pipe(Effect.forkIn(runtime.scope))
})
export const make = Effect.fnUntraced(function* (
	emit: (message: Wire.CallMessage) => Effect.Effect<void>,
): Effect.fn.Return<Owner, never, Scope.Scope> {
	const runtime: Runtime = {
		errors: yield* Queue.bounded<Cause.Cause<unknown>>(256),
		scope: yield* Effect.scope,
		emit,
		records: yield* Ref.make(HashMap.empty<string, Registered>()),
		fibers: yield* FiberMap.make<string, void, never>(),
	}
	return {
		failures: Stream.fromQueue(runtime.errors),
		register: (grant) =>
			Ref.update(runtime.records, (records) =>
				HashMap.has(records, grant.key)
					? records
					: HashMap.set(records, grant.key, {
							grant,
							started: false,
							cancelled: false,
							completion: Option.none(),
						}),
			),
		cancel: (key) => cancel(runtime, key),
		ack: (key) =>
			Ref.update(runtime.records, (records) =>
				Option.exists(HashMap.get(records, key), (r) =>
					Option.isSome(r.completion),
				)
					? HashMap.remove(records, key)
					: records,
			),
		reconcile: Ref.get(runtime.records).pipe(
			Effect.flatMap((records) =>
				Effect.forEach(
					HashMap.values(records),
					(r) =>
						Option.match(r.completion, {
							onNone: () => Effect.void,
							onSome: emit,
						}),
					{ discard: true },
				),
			),
			Effect.catchCause((cause) =>
				Queue.offer(runtime.errors, cause).pipe(Effect.asVoid),
			),
		),
		pending: Ref.get(runtime.records).pipe(Effect.map(HashMap.size)),
		run: (effect, ticket, tag) => run(runtime, effect, ticket, tag),
	}
})
