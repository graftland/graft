import {
	Array,
	Cause,
	Clock,
	Context,
	Effect,
	Equal,
	Exit,
	HashMap,
	Option,
	TxRef,
} from "effect"

import * as Change from "../Change"
import * as Capacity from "./capacity"
import { emergency, execute } from "./changeExecution"
import { normalize, validate } from "./changeRequest"
import * as ChangeTable from "./changeTable"
import * as Generations from "./generations"
import { realmOf, Realms } from "./runtime"
import { RuntimeContext } from "./runtimeContext"
import {
	engine,
	ExecutionOutcome,
	safetyReserve,
	type Managed,
	type Run,
} from "./transition"
import type { Deadlines } from "./transitionBudgets"

const facts = Effect.fnUntraced(function* (
	managed: Managed,
	record: ChangeTable.Record,
	outcome: ExecutionOutcome,
) {
	const status = yield* TxRef.get(record.status)
	const route = yield* TxRef.get(managed.route)
	const conditions = yield* TxRef.get(record.conditions)
	const instance = Array.findFirst(
		conditions,
		(c) => c.object._tag === "Instance",
	)
	const version = Option.isSome(instance)
		? (yield* TxRef.get(instance.value.cell)).version
		: 0
	return Array.map(status.members, (member): Change.Member => ({
		...member,
		execution: Change.Execution.Completed({
			phase: outcome.phase,
			outcome: outcome._tag,
		}),
		actual: {
			version,
			generation: Option.map(route, (attempt) => attempt.id).pipe(
				Option.getOrUndefined,
			),
			health: Option.isSome(route) ? "Serving" : "Unavailable",
			matchesTarget: Option.exists(route, (attempt) =>
				Equal.equals(attempt.desired, record.request.candidate),
			),
		},
		recoverability: {
			possible: outcome._tag !== "Stuck",
			reason:
				outcome._tag === "Stuck"
					? "Settlement obligations remain unresolved"
					: "Recovery requires fresh resolution and current authorization",
		},
	}))
})
const publicOutcome = Effect.fnUntraced(function* (
	managed: Managed,
	record: ChangeTable.Record,
	outcome: ExecutionOutcome,
): Effect.fn.Return<Change.Outcome> {
	const result: Change.Result = {
		change: record.handle.id,
		phase: outcome.phase,
		evidence: outcome.evidence,
		members: yield* facts(managed, record, outcome),
	}
	switch (outcome._tag) {
		case "Accepted":
			return Change.Outcome.Accepted(result)
		case "Aborted":
			return Change.Outcome.Aborted({
				...result,
				reason: outcome.reason,
			})
		case "Recovered":
			return Change.Outcome.Recovered({
				...result,
				reason: outcome.reason,
			})
		case "RecoveryFailed":
			return Change.Outcome.RecoveryFailed({
				...result,
				reason: outcome.reason,
			})
		case "Stuck":
			return Change.Outcome.Stuck({
				...result,
				reason: outcome.reason,
			})
	}
})
const lateFact = (
	managed: Managed,
	record: ChangeTable.Record,
	next: Change.Settlement,
) =>
	Effect.tx(
		ChangeTable.update(managed.runtime.changes, record, (status) => ({
			...status,
			unconfirmedUnits:
				next.execution === "Unconfirmed"
					? status.unconfirmedUnits
					: Array.filter(
							status.unconfirmedUnits,
							(id) => id !== next.generation,
						),
			settlement: [
				...Array.filter(
					status.settlement,
					(old) => old.generation !== next.generation,
				),
				{
					...next,
					cause: Cause.combine(
						Option.map(
							Array.findFirst(
								status.settlement,
								(old) => old.generation === next.generation,
							),
							(old) => old.cause,
						).pipe(Option.getOrElse(() => Cause.empty)),
						next.cause,
					),
				},
			],
		})),
	)
const lateSettlement = Effect.fnUntraced(function* (
	managed: Managed,
	record: ChangeTable.Record,
	policy: Deadlines,
	run: Run,
) {
	const attempts = yield* TxRef.get(managed.attempts)
	const route = yield* TxRef.get(managed.route)
	const ownedLeases = yield* TxRef.get(managed.leases)
	const leases = Array.filter(
		ownedLeases,
		(lease) => !Option.exists(route, (serving) => serving.id === lease.id),
	)
	const coordinator = engine(managed, policy, run.evidence)
	const results = yield* Effect.forEach(
		leases,
		(lease) =>
			Effect.gen(function* () {
				const attempt = Array.findFirst(
					attempts,
					(attempt) => attempt.id === lease.id,
				)
				let execution: Change.Settlement["execution"] = "NotStarted"
				let exitCause: Cause.Cause<unknown> = Cause.empty
				if (Option.isSome(attempt)) {
					const known = yield* TxRef.get(attempt.value.terminated)
					if (Option.isNone(known))
						yield* Effect.suspend(() => attempt.value.unit.terminate).pipe(
							Effect.catchCause((cause) =>
								lateFact(managed, record, {
									generation: lease.id,
									execution: "Unconfirmed",
									cleanup: "Unknown",
									cause,
								}),
							),
							Effect.forkIn(managed.runtime.changes.scope),
						)
					const termination = Option.isSome(known)
						? known.value
						: yield* Effect.suspend(() => attempt.value.unit.exited)
					yield* TxRef.set(attempt.value.terminated, Option.some(termination))
					execution = termination.state
					exitCause = termination.cause ?? Cause.empty
				}
				yield* Effect.tx(
					Generations.settle(managed.entry.node, lease.generation).pipe(
						Effect.andThen(Capacity.end(managed.runtime.capacity, lease)),
					),
				)
				const host = yield* coordinator.releaseHost(lease)
				yield* lateFact(managed, record, {
					generation: lease.id,
					execution,
					cleanup: Exit.isSuccess(host)
						? "Completed"
						: Cause.hasInterruptsOnly(host.cause)
							? "Unknown"
							: "Failed",
					cause: Cause.combine(
						exitCause,
						Exit.isFailure(host) ? host.cause : Cause.empty,
					),
				})
				return Exit.isSuccess(host) || !Cause.hasInterruptsOnly(host.cause)
			}).pipe(
				Effect.catchCause((cause) =>
					lateFact(managed, record, {
						generation: lease.id,
						execution: "Unconfirmed",
						cleanup: "Unknown",
						cause,
					}).pipe(Effect.as(false)),
				),
			),
		{ concurrency: 8 },
	)
	if (Array.every(results, (complete) => complete))
		yield* Effect.tx(
			ChangeTable.release(record).pipe(
				Effect.andThen(ChangeTable.archive(managed.runtime.changes, record)),
			),
		)
})
const work = Effect.fnUntraced(function* (
	managed: Managed,
	policy: Deadlines,
	run: Run,
	record: ChangeTable.Record,
) {
	yield* TxRef.set(run.budget.reserved, safetyReserve(policy))
	const outcome = yield* execute(managed, policy, run).pipe(
		Effect.catchCause((cause) => emergency(managed, policy, run, cause)),
	)
	const published = yield* publicOutcome(managed, record, outcome)
	yield* Effect.tx(
		Effect.gen(function* () {
			const state = yield* TxRef.get(managed.lifecycle)
			if (
				(state._tag === "Open" || state._tag === "Closing") &&
				Option.contains(state.active, run)
			)
				yield* TxRef.set(managed.lifecycle, { ...state, active: Option.none() })
			yield* ChangeTable.finish(managed.runtime.changes, record, published)
			yield* TxRef.set(run.reply, Option.some(outcome))
		}),
	)
	if (outcome._tag === "Stuck")
		yield* Effect.interruptible(
			lateSettlement(managed, record, policy, run),
		).pipe(Effect.forkIn(managed.runtime.changes.scope))
})

export const submit = Effect.fnUntraced(function* (
	request: Change.Request,
): Effect.fn.Return<Change.Handle, Change.ChangeRejected, RuntimeContext> {
	const { runtime } = yield* RuntimeContext
	const normalized = yield* normalize(request, false)
	return yield* Effect.uninterruptible(
		Effect.gen(function* () {
			const run: Run = {
				reply: yield* TxRef.make(Option.none<ExecutionOutcome>()),
				previous: Option.none(),
				previousDesired: normalized.candidate,
				candidate: yield* TxRef.make(
					Option.none<import("./transition").Attempt>(),
				),
				cancel: yield* TxRef.make(false),
				record: undefined,
				evidence: yield* TxRef.make<ReadonlyArray<Change.Evidence>>([]),
				progress: yield* TxRef.make<{ attempt: number; phase: Change.Phase }>({
					attempt: 0,
					phase: "Admission",
				}),
				budget: {
					started: yield* Clock.monotonicTimeNanos,
					reserved: yield* TxRef.make(0),
				},
			}
			const admitted = yield* Effect.tx(
				Effect.gen(function* () {
					const table = runtime.changes
					const duplicate = yield* ChangeTable.duplicate(
						table,
						request.key,
						normalized,
					)
					if (Option.isSome(duplicate))
						return {
							_tag: "Duplicate",
							handle: duplicate.value.handle,
						} as const
					yield* validate(normalized)
					if (!(yield* TxRef.get(table.open)))
						return yield* Change.ChangeRejected.make({
							reason: { _tag: "Closing" },
						})
					const instances = yield* TxRef.get(runtime.instances)
					const found = HashMap.get(instances, normalized.instance)
					if (
						Option.isNone(found) ||
						normalized.candidate.driver !== found.value.driver.name
					)
						return yield* Change.ChangeRejected.make({
							reason: {
								_tag: "UnsupportedTarget",
								instance: normalized.instance,
							},
						})
					const managed = found.value
					const lifecycle = yield* TxRef.get(managed.lifecycle)
					if (lifecycle._tag === "Closing" || lifecycle._tag === "Closed")
						return yield* Change.ChangeRejected.make({
							reason: { _tag: "Closing" },
						})
					const instanceObject: Change.ObjectKey = {
						_tag: "Instance",
						instance: managed.instance,
					}
					const instanceCell = yield* ChangeTable.object(table, instanceObject)
					const held = yield* TxRef.get(instanceCell)
					if (Option.isSome(held.writer))
						return yield* Change.ChangeRejected.make({
							reason: {
								_tag: "Busy",
								conflicts: [
									{ object: instanceObject, holders: [held.writer.value] },
								],
							},
						})
					const current = yield* TxRef.get(managed.route)
					if (lifecycle._tag !== "Open")
						return yield* Change.ChangeRejected.make({
							reason: {
								_tag: "UnsupportedTarget",
								instance: normalized.instance,
							},
						})
					const strategy =
						normalized.strategy ??
						(Option.isSome(current) &&
						managed.driver.overlap?.(normalized.candidate) === true
							? "Overlap"
							: "Restart")
					if (
						strategy === "Overlap" &&
						managed.driver.overlap?.(normalized.candidate) !== true
					)
						return yield* Change.ChangeRejected.make({
							reason: {
								_tag: "Unsupported",
								message: "This driver has no verified overlap declaration",
							},
						})
					const key: Change.ObjectKey = {
						_tag: "Instance",
						instance: managed.instance,
					}
					const cell = yield* ChangeTable.object(table, key)
					const version = (yield* TxRef.get(cell)).version
					if (
						normalized.expected !== undefined &&
						normalized.expected !== version
					)
						return yield* Change.ChangeRejected.make({
							reason: {
								_tag: "Stale",
								object: key,
								expected: normalized.expected,
								actual: version,
							},
						})
					const sequence = yield* TxRef.get(table.next)
					const id = Change.Id.make(`change-${sequence}`)
					const realms = Context.get(managed.context, Realms)
					const conditions = yield* ChangeTable.reserve(table, id, [
						{ object: key, write: true },
						...Array.map(managed.facades, (facade) => ({
							object: {
								_tag: "Slot",
								realm: realmOf(realms, facade.key),
								key: facade.key,
							} satisfies Change.ObjectKey,
							write: true,
						})),
					])
					const members: ReadonlyArray<Change.Member> = [
						{
							instance: managed.instance,
							selection: "Requested",
							starting: {
								version,
								health: Option.isSome(current) ? "Serving" : "Unavailable",
							},
							desired: {
								candidate: normalized.candidate,
								version: version + 1,
							},
							execution: Change.Execution.NotStarted(),
							compensation: "NotNeeded",
							actual: {
								version,
								generation: Option.map(current, (attempt) => attempt.id).pipe(
									Option.getOrUndefined,
								),
								health: Option.isSome(current) ? "Serving" : "Unavailable",
								matchesTarget: false,
							},
							recoverability: {
								possible: true,
								reason:
									"Recovery requires fresh resolution and current authorization",
							},
						},
					]
					const status = yield* TxRef.make<Change.Status>({
						id,
						key: request.key,
						source: "Application",
						sequence: 0,
						instance: managed.instance,
						strategy,
						phase: "Admission",
						remaining: normalized.budget.total,
						members,
						leaseHolders: [],
						unconfirmedUnits: Option.isSome(current) ? [current.value.id] : [],
						evidence: [],
						settlement: [],
						outcome: Option.none(),
					})
					const handle: Change.Handle = {
						id,
						await: Effect.tx(
							TxRef.get(status).pipe(
								Effect.flatMap((s) =>
									Option.match(s.outcome, {
										onNone: () => Effect.txRetry,
										onSome: Effect.succeed,
									}),
								),
							),
						),
						cancel: TxRef.set(run.cancel, true),
					}
					const capacity = yield* Capacity.reserve(
						runtime.capacity,
						strategy === "Overlap" && Option.isSome(current) ? 2 : 1,
						Option.isSome(current) ? 1 : 0,
					)
					if (Option.isSome(current))
						yield* TxRef.set(current.value.capacity, Option.some(capacity))
					const record: ChangeTable.Record = {
						capacity,
						oldChanged: yield* TxRef.make(Option.isNone(current)),
						started: run.budget.started,
						request: normalized,
						status,
						cancelled: run.cancel,
						conditions:
							yield* TxRef.make<ReadonlyArray<ChangeTable.Condition>>(
								conditions,
							),
						handle,
					}
					yield* TxRef.set(table.next, sequence + 1)
					yield* TxRef.update(table.records, HashMap.set(id, record))
					if (request.key !== undefined)
						yield* TxRef.update(table.keys, HashMap.set(request.key, record))
					const active: Run = {
						...run,
						record,
						previous: current,
						previousDesired: yield* TxRef.get(managed.desired),
					}
					yield* TxRef.set(managed.lifecycle, {
						_tag: "Open",
						active: Option.some(active),
					})
					yield* ChangeTable.update(table, record, (s) => s)
					return {
						_tag: "Admitted",
						record,
						managed,
						run: active,
						attempt: Option.map(current, (attempt) => attempt.id).pipe(
							Option.getOrElse(() => 0),
						),
					} as const
				}),
			)
			if (admitted._tag === "Duplicate") return admitted.handle
			yield* TxRef.set<{
				readonly attempt: number
				readonly phase: Change.Phase
			}>(run.progress, {
				attempt: admitted.attempt,
				phase: "Admission",
			})
			const policy: Deadlines = {
				...normalized.budget,
				...normalized.requirements,
			}
			yield* work(admitted.managed, policy, admitted.run, admitted.record).pipe(
				Effect.provideContext(admitted.managed.context),
				Effect.forkIn(runtime.changes.scope, { uninterruptible: true }),
			)
			return admitted.record.handle
		}),
	)
})
