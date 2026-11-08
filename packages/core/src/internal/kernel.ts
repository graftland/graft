import {
	Array as Arr,
	Cause,
	Clock,
	HashSet as CoreSet,
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
import { Digest } from "effect/crypto"

import * as Core from "./decisionCore"
import { waitUntil } from "./kernelDeadline"
import { UnknownChange } from "./observation"
import * as Recording from "./recordingCore"
import { UnitControl } from "./unitControl"

export interface Completion {
	readonly id: string
	readonly await: Effect.Effect<Core.Conclusion>
	readonly cancel: Effect.Effect<void>
}
export interface Submission {
	readonly reply: Core.Reply
	readonly completion: Option.Option<Completion>
	readonly inspection: Option.Option<Core.PreparationStatus>
}
export interface Controller {
	readonly waiters: Effect.Effect<ReadonlyArray<Core.CallWaiter>>
	readonly calls: Effect.Effect<ReadonlyArray<Core.CallFact>>
	readonly callChanges: Stream.Stream<Core.CallFact>
	readonly time: Effect.Effect<number>
	readonly apply: (event: Core.Event) => Effect.Effect<Core.Reply>
	readonly submit: (request: Core.Input) => Effect.Effect<Submission>
	readonly inspect: (request: Core.InspectionInput) => Effect.Effect<Submission>
	readonly getPreparation: (
		id: string,
	) => Effect.Effect<Option.Option<Core.PreparationStatus>>
	readonly preparations: Stream.Stream<Core.PreparationStatus>
	readonly get: (id: string) => Effect.Effect<Option.Option<Core.Status>>
	readonly snapshot: Effect.Effect<Core.State>
	readonly await: (id: string) => Effect.Effect<Core.Conclusion, UnknownChange>
	readonly changes: Stream.Stream<Core.Status>
	readonly shutdown: Effect.Effect<void>
}
interface Runtime {
	readonly digest: Digest.Digest["Service"]
	readonly state: TxRef.TxRef<Core.State>
	readonly outbox: TxQueue.TxQueue<Core.Command>
	readonly callEvents: TxPubSub.TxPubSub<Core.CallFact>
	readonly events: TxPubSub.TxPubSub<Core.Status>
	readonly preparations: TxPubSub.TxPubSub<Core.PreparationStatus>
	readonly submissions: TxRef.TxRef<
		HashMap.HashMap<string, Deferred.Deferred<Submission>>
	>
	readonly deliveries: TxRef.TxRef<HashMap.HashMap<string, Completion>>
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
const completion = (
	runtime: Runtime,
	id: string,
	mailbox: Deferred.Deferred<Core.Conclusion>,
): Completion => ({
	id,
	await: Deferred.await(mailbox),
	cancel: Effect.gen(function* () {
		const now = yield* time(runtime)
		yield* consume(runtime, {
			_tag: "Cancel",
			change: id,
			cause: Cause.fail("Cancelled"),
			now,
		})
	}),
})
const consumeTx = Effect.fnUntraced(function* (
	runtime: Runtime,
	event: Core.Event,
) {
	const previous = yield* TxRef.get(runtime.state)
	const transition = Core.reduce(previous, event)
	yield* TxRef.set(runtime.state, transition.state)
	const admissions =
		transition.reply._tag === "Admitted"
			? Option.some(transition.reply)
			: Option.none()
	const actions: ReadonlyArray<{
		readonly mailbox: Deferred.Deferred<Core.Conclusion>
		readonly conclusion: Core.Conclusion
	}> = yield* Option.match(admissions, {
		onNone: () => Effect.succeed([]),
		onSome: Effect.fnUntraced(function* (reply) {
			const boxes = yield* TxRef.get(runtime.completions)
			const existing = HashMap.get(boxes, reply.change)
			const mailbox = Option.isSome(existing)
				? existing.value
				: yield* Deferred.make<Core.Conclusion>()
			yield* TxRef.set(
				runtime.completions,
				HashMap.set(boxes, reply.change, mailbox),
			)
			const pending = yield* TxRef.get(runtime.submissions)
			if (
				reply.preparation !== undefined &&
				HashMap.has(pending, reply.preparation)
			)
				yield* TxRef.update(
					runtime.deliveries,
					HashMap.set(
						reply.preparation,
						completion(runtime, reply.change, mailbox),
					),
				)
			const concluded = Option.flatMap(
				Core.get(transition.state, reply.change),
				(s) => s.conclusion,
			)
			return Option.isSome(concluded)
				? [{ mailbox, conclusion: concluded.value }]
				: []
		}),
	})
	yield* TxQueue.offerAll(runtime.outbox, transition.commands)
	return { reply: transition.reply, actions }
})
const completeActions = (
	actions: ReadonlyArray<{
		readonly mailbox: Deferred.Deferred<Core.Conclusion>
		readonly conclusion: Core.Conclusion
	}>,
) =>
	Effect.forEach(actions, (a) => Deferred.succeed(a.mailbox, a.conclusion), {
		discard: true,
	})
const consume = Effect.fnUntraced(function* (
	runtime: Runtime,
	event: Core.Event,
) {
	const result = yield* Effect.tx(consumeTx(runtime, event))
	yield* completeActions(result.actions)
	return result.reply
}, Effect.uninterruptible)
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
const publishPreparation = Effect.fnUntraced(function* (
	runtime: Runtime,
	command: Core.Command,
) {
	const status = command.preparation
	if (status === undefined) return
	if (Option.isSome(status.result)) {
		const pending = yield* TxRef.get(runtime.submissions)
		const waiter = HashMap.get(pending, status.id)
		const deliveries = yield* TxRef.get(runtime.deliveries)
		const result = status.result.value
		const reply: Core.Reply =
			result._tag === "Rejected"
				? {
						_tag: "Rejected",
						reason: result.reason,
						conflicts: result.conflicts,
						preparation: status.id,
						cause: status.cause,
					}
				: result._tag === "Admitted"
					? { _tag: "Admitted", change: result.change, preparation: status.id }
					: { _tag: "Preparing", preparation: status.id }
		if (Option.isSome(waiter))
			yield* Deferred.succeed(waiter.value, {
				reply,
				completion: HashMap.get(deliveries, status.id),
				inspection: Option.some(status),
			})
		yield* TxRef.update(runtime.submissions, HashMap.remove(status.id))
		yield* TxRef.update(runtime.deliveries, HashMap.remove(status.id))
	}
	yield* TxPubSub.publish(runtime.preparations, status)
})
const fire = Effect.fnUntraced(function* (runtime: Runtime, timer: Core.Timer) {
	const observed = yield* waitUntil(time(runtime), timer.deadline)
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
		case "PublishCall":
			if (command.callStatus !== undefined)
				yield* TxPubSub.publish(runtime.callEvents, command.callStatus)
			return { _tag: "Succeeded" }
		case "CallArmTimer":
			if (command.call?.deadline !== undefined) {
				const call = command.call
				yield* FiberMap.run(
					runtime.timers,
					`call:${call.key}`,
					Effect.gen(function* () {
						const observed = yield* waitUntil(time(runtime), call.deadline ?? 0)
						yield* consume(runtime, {
							_tag: "CallExpired",
							key: call.key,
							now: observed,
						})
					}),
					{ onlyIfMissing: true },
				)
			}
			return { _tag: "Succeeded" }
		case "PublishPreparation":
			yield* publishPreparation(runtime, command)
			return { _tag: "Succeeded" }
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
): Effect.Effect<Core.Conclusion, UnknownChange> =>
	Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(runtime.state)
			const status = Core.get(state, id)
			if (Option.isNone(status)) return yield* UnknownChange.make({ id })
			const result = status.value.conclusion
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
				CoreSet.some(
					CoreSet.fromIterable(HashMap.keys(state.preparations)),
					(id) =>
						Option.exists(HashMap.get(state.preparations, id), (p) =>
							Option.isNone(p.result),
						),
				) ||
				Arr.some(Arr.fromIterable(state.active), (id) =>
					Option.exists(
						HashMap.get(state.changes, id),
						(c) =>
							Option.isNone(c.conclusion) &&
							// Finished execution whose record can no longer be acknowledged stays
							// visibly recording-blocked; shutdown does not wait for it.
							!(
								Option.contains(c.recordingGate, "Conclusion") &&
								Option.exists(
									Core.get(state, id),
									(status) => status.recording.blocked,
								)
							),
					),
				)
			)
				return yield* Effect.txRetry
		}),
	)
})
const handoff = Effect.fnUntraced(function* (
	runtime: Runtime,
	input:
		| { readonly _tag: "Requested"; readonly request: Core.Input }
		| {
				readonly _tag: "InspectRequested"
				readonly request: Core.InspectionInput
		  },
) {
	const waiting = yield* Deferred.make<Submission>()
	const now = yield* time(runtime)
	const selected = yield* Effect.tx(
		Effect.gen(function* () {
			const result = yield* consumeTx(runtime, { ...input, now })
			if (result.reply._tag === "Preparing") {
				const pending = yield* TxRef.get(runtime.submissions)
				const status = yield* TxRef.get(runtime.state).pipe(
					Effect.map((s) =>
						Core.getPreparation(
							s,
							result.reply._tag === "Preparing" ? result.reply.preparation : "",
						),
					),
				)
				if (Option.isSome(status) && Option.isSome(status.value.result))
					return {
						reply: result.reply,
						actions: result.actions,
						waiting: Option.none<Deferred.Deferred<Submission>>(),
						inspection: status,
					}
				const mailbox = Option.getOrElse(
					HashMap.get(pending, result.reply.preparation),
					() => waiting,
				)
				yield* TxRef.set(
					runtime.submissions,
					HashMap.set(pending, result.reply.preparation, mailbox),
				)
				return {
					...result,
					waiting: Option.some(mailbox),
					inspection: Option.none<Core.PreparationStatus>(),
				}
			}
			return {
				...result,
				waiting: Option.none<Deferred.Deferred<Submission>>(),
				inspection: Option.none<Core.PreparationStatus>(),
			}
		}),
	)
	yield* completeActions(selected.actions)
	const boxes = yield* TxRef.get(runtime.completions)
	const handle =
		selected.reply._tag === "Admitted"
			? Option.map(HashMap.get(boxes, selected.reply.change), (mailbox) =>
					completion(
						runtime,
						selected.reply._tag === "Admitted" ? selected.reply.change : "",
						mailbox,
					),
				)
			: Option.none<Completion>()
	return {
		waiting: selected.waiting,
		result: {
			reply: selected.reply,
			completion: handle,
			inspection: selected.inspection,
		},
	}
}, Effect.uninterruptible)
const submit = Effect.fnUntraced(function* (
	runtime: Runtime,
	input:
		| { readonly _tag: "Requested"; readonly request: Core.Input }
		| {
				readonly _tag: "InspectRequested"
				readonly request: Core.InspectionInput
		  },
): Effect.fn.Return<Submission> {
	// A keyed request is fingerprinted here, so records never hold its content.
	const fingerprinted =
		input._tag === "Requested" && input.request.key !== undefined
			? {
					...input,
					request: {
						...input.request,
						fingerprint: yield* runtime.digest.digestHex(
							Digest.sha256,
							new TextEncoder().encode(
								Recording.requestText(Core.normalizedIdentity(input.request)),
							),
						),
					},
				}
			: input
	const delivery = yield* handoff(runtime, fingerprinted)
	return Option.isSome(delivery.waiting)
		? yield* Deferred.await(delivery.waiting.value)
		: delivery.result
})
export const make = Effect.fnUntraced(function* (
	initial: Core.State,
): Effect.fn.Return<
	Controller,
	never,
	Scope.Scope | UnitControl | Digest.Digest
> {
	const runtime: Runtime = {
		digest: yield* Digest.Digest,
		state: yield* TxRef.make(initial),
		outbox: yield* TxQueue.bounded<Core.Command>(1024 + initial.maxUnits * 256),
		events: yield* TxPubSub.sliding<Core.Status>(64),
		callEvents: yield* TxPubSub.sliding<Core.CallFact>(64),
		preparations: yield* TxPubSub.sliding<Core.PreparationStatus>(64),
		submissions: yield* TxRef.make(
			HashMap.empty<string, Deferred.Deferred<Submission>>(),
		),
		deliveries: yield* TxRef.make(HashMap.empty<string, Completion>()),
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
	yield* Stream.runForEach(runtime.control.events, (event) =>
		Effect.gen(function* () {
			const now = yield* time(runtime)
			yield* consume(runtime, { ...event, now })
		}),
	).pipe(Effect.forkScoped)
	yield* Effect.addFinalizer(() => close(runtime))
	return {
		waiters: TxRef.get(runtime.state).pipe(
			Effect.map((s) => Arr.fromIterable(HashMap.values(s.callWaiters))),
		),
		calls: TxRef.get(runtime.state).pipe(
			Effect.map((s) => Arr.fromIterable(HashMap.values(s.calls))),
		),
		callChanges: Stream.unwrap(
			Effect.map(TxPubSub.subscribe(runtime.callEvents), (queue) =>
				Stream.fromEffectRepeat(TxQueue.take(queue)),
			),
		),
		time: time(runtime),
		apply: (event) => consume(runtime, event),
		submit: (request) => submit(runtime, { _tag: "Requested", request }),
		inspect: (request) =>
			submit(runtime, { _tag: "InspectRequested", request }),
		getPreparation: Effect.fnUntraced(function* (id: string) {
			const now = yield* time(runtime)
			yield* consume(runtime, {
				_tag: "PreparationObserved",
				preparation: id,
				now,
			})
			const state = yield* TxRef.get(runtime.state)
			return Core.getPreparation(state, id)
		}),
		preparations: Stream.unwrap(
			Effect.map(TxPubSub.subscribe(runtime.preparations), (queue) =>
				Stream.fromEffectRepeat(TxQueue.take(queue)),
			),
		),
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
