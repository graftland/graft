import {
	Array as Arr,
	Cause,
	Clock,
	Deferred,
	Effect,
	Exit,
	FiberMap,
	HashMap,
	Option,
	Scope,
	Stream,
	TxPubSub,
	TxQueue,
	TxRef,
} from "effect"

import * as Core from "./decisionCore"
import { UnitControl } from "./unitControl"

export interface Completion {
	readonly id: string
	readonly await: Effect.Effect<Core.Conclusion>
	readonly cancel: Effect.Effect<void>
}
export interface Controller {
	readonly apply: (event: Core.Event) => Effect.Effect<Core.Reply>
	readonly submit: (request: Core.Request | Core.Input) => Effect.Effect<{
		readonly reply: Core.Reply
		readonly completion: Option.Option<Completion>
	}>
	readonly get: (id: string) => Effect.Effect<Option.Option<Core.Status>>
	readonly snapshot: Effect.Effect<Core.State>
	readonly await: (id: string) => Effect.Effect<Core.Conclusion>
	readonly changes: Stream.Stream<Core.Status>
	readonly shutdown: Effect.Effect<void>
}
interface Runtime {
	readonly state: TxRef.TxRef<Core.State>
	readonly outbox: TxQueue.TxQueue<Core.Command>
	readonly events: TxPubSub.TxPubSub<Core.Status>
	readonly completions: TxRef.TxRef<
		HashMap.HashMap<string, Deferred.Deferred<Core.Conclusion>>
	>
	readonly commands: FiberMap.FiberMap<string, void, never>
	readonly timers: FiberMap.FiberMap<string, void, never>
	readonly control: UnitControl["Service"]
	readonly origin: bigint
	readonly initialTime: number
}
const time = Effect.fnUntraced(function* (runtime: Runtime) {
	const now = yield* Clock.monotonicTimeNanos
	return runtime.initialTime + Number(now - runtime.origin) / 1_000_000
})
const consume = Effect.fnUntraced(function* (
	runtime: Runtime,
	event: Core.Event,
) {
	const previous = yield* TxRef.get(runtime.state)
	const transition = Core.reduce(previous, event)
	yield* TxRef.set(runtime.state, transition.state)
	yield* TxQueue.offerAll(runtime.outbox, transition.commands)
	return transition.reply
}, Effect.tx)
const report = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Core.Command,
	result: Core.Report,
) {
	const now = yield* time(runtime)
	yield* consume(runtime, {
		_tag: "Reported",
		command: command.id,
		token: command.token,
		result,
		now,
	})
})
const publish = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Core.Command,
) {
	if (Option.isNone(command.status)) return
	const status = command.status.value
	const waiting = yield* TxRef.get(runtime.completions)
	const mailbox = HashMap.get(waiting, status.id)
	if (Option.isSome(status.conclusion) && Option.isSome(mailbox)) {
		yield* Deferred.succeed(mailbox.value, status.conclusion.value)
		yield* TxRef.update(runtime.completions, (pending) =>
			HashMap.remove(pending, status.id),
		)
	}
	yield* TxPubSub.publish(runtime.events, status)
})
const fire = Effect.fnUntraced(function* (runtime: Runtime, timer: Core.Timer) {
	const now = yield* time(runtime)
	yield* Effect.sleep(Math.max(0, timer.deadline - now))
	const observed = yield* time(runtime)
	yield* consume(runtime, {
		_tag: "TimerFired",
		timer: timer.id,
		generation: timer.generation,
		now: observed,
	})
})
const arm = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Core.Command,
) {
	const state = yield* TxRef.get(runtime.state)
	const timer = Option.flatMap(command.timer, (id) =>
		HashMap.get(state.timers, id),
	)
	if (Option.isSome(timer))
		yield* FiberMap.run(
			runtime.timers,
			timer.value.id,
			fire(runtime, timer.value).pipe(
				Effect.onExit((exit) =>
					Exit.isFailure(exit)
						? Effect.gen(function* () {
								const now = yield* time(runtime)
								if (Option.isSome(timer))
									yield* consume(runtime, {
										_tag: "TimerEnded",
										timer: timer.value.id,
										generation: timer.value.generation,
										cause: exit.cause,
										now,
									})
							})
						: Effect.void,
				),
			),
			{ onlyIfMissing: true },
		)
})
const execute = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Core.Command,
): Effect.fn.Return<Core.Report> {
	switch (command.kind) {
		case "Publish":
			yield* publish(runtime, command)
			return { _tag: "Succeeded" }
		case "ArmTimer":
			yield* arm(runtime, command)
			return { _tag: "Succeeded" }
		case "CancelTimer": {
			if (Option.isSome(command.timer))
				yield* FiberMap.remove(runtime.timers, command.timer.value)
			return { _tag: "Succeeded" }
		}
		default:
			return yield* runtime.control.send(command)
	}
})
const runCommand = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Core.Command,
) {
	yield* Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(restore(execute(runtime, command)))
			yield* report(
				runtime,
				command,
				Exit.isSuccess(exit)
					? exit.value
					: { _tag: "Failed", cause: exit.cause, creation: "Unknown" },
			)
		}),
	)
})
const dispatch = Effect.fnUntraced(function* (runtime: Runtime) {
	yield* Effect.uninterruptibleMask((restore) =>
		restore(TxQueue.take(runtime.outbox)).pipe(
			Effect.flatMap((command) =>
				FiberMap.run(
					runtime.commands,
					command.id,
					runCommand(runtime, command),
					{ onlyIfMissing: true },
				),
			),
			Effect.asVoid,
		),
	)
})
const waitConclusion = (
	runtime: Runtime,
	id: string,
): Effect.Effect<Core.Conclusion> =>
	Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(runtime.state)
			const result = Option.flatMap(Core.get(state, id), (s) => s.conclusion)
			if (Option.isNone(result)) return yield* Effect.txRetry
			return result.value
		}),
	)
const close = Effect.fnUntraced(function* (runtime: Runtime) {
	const now = yield* time(runtime)
	yield* consume(runtime, { _tag: "Shutdown", now })
	yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(runtime.state)
			if (
				Arr.some(Arr.fromIterable(state.active), (id) =>
					Option.exists(HashMap.get(state.changes, id), (c) =>
						Option.isNone(c.conclusion),
					),
				)
			)
				return yield* Effect.txRetry
		}),
	)
})
const submit = Effect.fnUntraced(function* (
	runtime: Runtime,
	request: Core.Request | Core.Input,
) {
	const mailbox = yield* Deferred.make<Core.Conclusion>()
	const now = yield* time(runtime)
	const result = yield* Effect.tx(
		Effect.gen(function* () {
			const reply = yield* consume(
				runtime,
				"reads" in request
					? { _tag: "Submit", request, now }
					: { _tag: "Requested", request, now },
			)
			if (reply._tag !== "Admitted")
				return {
					reply,
					mailbox: Option.none<Deferred.Deferred<Core.Conclusion>>(),
					conclusion: Option.none<Core.Conclusion>(),
				}
			const state = yield* TxRef.get(runtime.state)
			const pending = yield* TxRef.get(runtime.completions)
			const existing = HashMap.get(pending, reply.change)
			const conclusion = Option.flatMap(
				Core.get(state, reply.change),
				(s) => s.conclusion,
			)
			const selected = Option.getOrElse(existing, () => mailbox)
			if (Option.isNone(conclusion))
				yield* TxRef.set(
					runtime.completions,
					HashMap.set(pending, reply.change, selected),
				)
			return { reply, mailbox: Option.some(selected), conclusion }
		}),
	)
	if (Option.isSome(result.mailbox) && Option.isSome(result.conclusion))
		yield* Deferred.succeed(result.mailbox.value, result.conclusion.value)
	const completion =
		result.reply._tag === "Admitted"
			? Option.map(result.mailbox, (mailbox): Completion => ({
					id: result.reply._tag === "Admitted" ? result.reply.change : "",
					await: Deferred.await(mailbox),
					cancel: Effect.gen(function* () {
						const now = yield* time(runtime)
						if (result.reply._tag === "Admitted")
							yield* consume(runtime, {
								_tag: "Cancel",
								change: result.reply.change,
								cause: Cause.fail("Cancelled"),
								now,
							})
					}),
				}))
			: Option.none<Completion>()
	return { reply: result.reply, completion }
}, Effect.uninterruptible)
export const make = Effect.fnUntraced(function* (
	initial: Core.State,
): Effect.fn.Return<Controller, never, Scope.Scope | UnitControl> {
	const runtime: Runtime = {
		state: yield* TxRef.make(initial),
		outbox: yield* TxQueue.unbounded<Core.Command>(),
		events: yield* TxPubSub.sliding<Core.Status>(64),
		completions: yield* TxRef.make(
			HashMap.empty<string, Deferred.Deferred<Core.Conclusion>>(),
		),
		commands: yield* FiberMap.make<string, void, never>(),
		timers: yield* FiberMap.make<string, void, never>(),
		control: yield* UnitControl,
		origin: yield* Clock.monotonicTimeNanos,
		initialTime: initial.now,
	}
	yield* dispatch(runtime).pipe(Effect.forever, Effect.forkScoped)
	yield* Effect.addFinalizer(() => close(runtime))
	return {
		apply: (event) => consume(runtime, event),
		submit: (request) => submit(runtime, request),
		snapshot: TxRef.get(runtime.state),
		await: (id) => waitConclusion(runtime, id),
		shutdown: close(runtime),
		get: Effect.fnUntraced(function* (id: string) {
			const now = yield* time(runtime)
			yield* consume(runtime, { _tag: "Observed", change: id, now })
			const state = yield* TxRef.get(runtime.state)
			return Core.get(state, id)
		}),
		changes: Stream.unwrap(
			Effect.gen(function* () {
				const queue = yield* TxPubSub.subscribe(runtime.events)
				return Stream.fromEffectRepeat(TxQueue.take(queue))
			}),
		),
	}
})
