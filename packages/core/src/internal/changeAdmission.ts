import {
	Array,
	Cause,
	Clock,
	Context,
	Effect,
	HashMap,
	Option,
	TxRef,
} from "effect"

import * as Change from "../Change"
import * as Plugin from "../Plugin"
import * as Capacity from "./capacity"
import type { Preparation } from "./changePreparation"
import { validate, type Normalized } from "./changeRequest"
import * as ChangeTable from "./changeTable"
import { captureEdges, resolutionChanged } from "./dependencies"
import { realmOf, Realms, type Runtime } from "./runtime"
import { ExecutionOutcome, type Managed, type Run } from "./transition"
import * as Trust from "./trust"

const footprint = Effect.fnUntraced(function* (managed: Managed) {
	const realms = Context.get(managed.context, Realms)
	const spec = yield* TxRef.get(managed.entry.spec)
	const facadeKeys = Array.map(managed.facades, (facade) => facade.key)
	const dependencyKeys = Array.dedupe(
		Array.map(spec.plugin.inject, (dependency) =>
			Plugin.isOptional(dependency) ? dependency.key.key : dependency.key,
		),
	)
	const readSlots = Array.filter(
		dependencyKeys,
		(key) => !Array.contains(facadeKeys, key),
	)
	return [
		...Array.map(
			captureEdges(managed.instance, managed.resolution),
			(object) => ({ object, write: true }),
		),
		...Array.map(readSlots, (key) => ({
			object: {
				_tag: "Slot",
				realm: realmOf(realms, key),
				key,
			} satisfies Change.ObjectKey,
			write: false,
		})),
		{
			object: {
				_tag: "Instance",
				instance: managed.instance,
			} satisfies Change.ObjectKey,
			write: true,
		},
		// Phase 1 preserves facade publication and ownership; cutover changes only the route.
		...Array.map(managed.facades, (facade) => ({
			object: {
				_tag: "Slot",
				realm: realmOf(realms, facade.key),
				key: facade.key,
			} satisfies Change.ObjectKey,
			write: false,
		})),
	]
})
export interface Plan {
	readonly managed: Managed
	readonly conditions: ReadonlyArray<ChangeTable.Condition>
}
const checkPlan = Effect.fnUntraced(function* (plan: Plan) {
	for (const condition of plan.conditions) {
		const current = yield* TxRef.get(condition.cell)
		if (current.version !== condition.version)
			return yield* Change.ChangeRejected.make({
				reason: {
					_tag: "Stale",
					object: condition.object,
					expected: condition.version,
					actual: current.version,
				},
			})
	}
})

export const preflight = Effect.fnUntraced(function* (
	runtime: Runtime,
	request: Change.Request,
	normalized: Normalized,
) {
	const duplicate = yield* ChangeTable.duplicate(
		runtime.changes,
		request.key,
		normalized,
	)
	if (Option.isSome(duplicate))
		return { _tag: "Duplicate", handle: duplicate.value.handle } as const
	yield* validate(normalized)
	if (!(yield* TxRef.get(runtime.changes.open)))
		return yield* Change.ChangeRejected.make({
			reason: { _tag: "Closing" },
		})
	const instances = yield* TxRef.get(runtime.instances)
	const managed = HashMap.get(instances, normalized.instance)
	const object: Change.ObjectKey = {
		_tag: "Instance",
		instance: normalized.instance,
	}
	const cell = yield* ChangeTable.object(runtime.changes, object)
	const held = yield* TxRef.get(cell)
	if (Option.isSome(held.writer))
		return yield* Change.ChangeRejected.make({
			reason: {
				_tag: "Busy",
				conflicts: [{ object, holders: [held.writer.value] }],
			},
		})
	if (
		Option.isNone(managed) ||
		managed.value.driver.name !== normalized.candidate.driver
	)
		return yield* Change.ChangeRejected.make({
			reason: { _tag: "UnsupportedTarget", instance: normalized.instance },
		})
	const objects = yield* footprint(managed.value)
	const conditions = yield* Effect.forEach(objects, (object) =>
		Effect.gen(function* () {
			const cell = yield* ChangeTable.object(runtime.changes, object.object)
			const current = yield* TxRef.get(cell)
			return { ...object, cell, version: current.version }
		}),
	)
	return { _tag: "Prepare", managed: managed.value, conditions } as const
}, Effect.tx)

export const makeRun = Effect.fnUntraced(function* (
	normalized: Normalized,
): Effect.fn.Return<Run> {
	const span = yield* Effect.option(Effect.currentSpan)
	return {
		trace: Option.map(span, (span) => ({
			traceId: span.traceId,
			spanId: span.spanId,
		})).pipe(Option.getOrUndefined),
		reply: yield* TxRef.make(Option.none<ExecutionOutcome>()),
		previous: Option.none(),
		previousDesired: normalized.candidate,
		candidate: yield* TxRef.make(Option.none<import("./transition").Attempt>()),
		cancel: yield* TxRef.make(false),
		record: undefined,
		evidence: yield* TxRef.make<ReadonlyArray<Change.Evidence>>([]),
		progress: yield* TxRef.make<{
			attempt: number | undefined
			phase: Change.Phase
		}>({
			attempt: undefined,
			phase: "Admission",
		}),
		budget: {
			started: yield* Clock.monotonicTimeNanos,
			reserved: yield* TxRef.make(0),
		},
	}
})

const select = Effect.fnUntraced(function* (
	runtime: Runtime,
	normalized: Normalized,
	preparation: Preparation,
	plan: Plan,
) {
	yield* checkPlan(plan)
	const table = runtime.changes
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
	if (yield* resolutionChanged(managed.resolution))
		return yield* Change.ChangeRejected.make({
			reason: {
				_tag: "Unsupported",
				message:
					"Captured dependencies changed; a fresh registration is required",
			},
		})
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
				conflicts: [{ object: instanceObject, holders: [held.writer.value] }],
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
		(Option.isSome(current) && preparation.value.overlap
			? "Overlap"
			: "Restart")
	if (strategy === "Overlap" && !preparation.value.overlap)
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
	if (normalized.expected !== undefined && normalized.expected !== version)
		return yield* Change.ChangeRejected.make({
			reason: {
				_tag: "Stale",
				object: key,
				expected: normalized.expected,
				actual: version,
			},
		})

	return { managed, current, strategy, key, version }
})
type Selection = Effect.Success<ReturnType<typeof select>>

const reserve = Effect.fnUntraced(function* (
	runtime: Runtime,
	normalized: Normalized,
	selection: Selection,
	id: Change.Id,
	plan: Plan,
) {
	const table = runtime.changes
	const { managed } = selection
	yield* checkPlan(plan)
	const conditions = yield* ChangeTable.reserve(table, id, plan.conditions)
	const authorization = yield* Trust.snapshot(
		runtime,
		managed.instance,
		normalized.candidate.identity,
	).pipe(
		Effect.mapError((error) =>
			Change.ChangeRejected.make({
				reason: {
					_tag: "Unsupported",
					message: "Candidate authorization failed",
				},
				cause: Cause.fail(error),
			}),
		),
	)

	return { conditions, authorization }
})
type Premises = Effect.Success<ReturnType<typeof reserve>>

const makeRecord = Effect.fnUntraced(function* (
	runtime: Runtime,
	request: Change.Request,
	normalized: Normalized,
	run: Run,
	preparation: Preparation,
	selection: Selection,
	premises: Premises,
	id: Change.Id,
) {
	const { managed, current, strategy, version } = selection
	const { conditions, authorization } = premises
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
				reason: "Recovery requires fresh resolution and current authorization",
			},
		},
	]
	const status = yield* TxRef.make<Change.Status>({
		id,
		key: request.key,
		source: "Application",
		trace: run.trace,
		sequence: 0,
		instance: managed.instance,
		strategy,
		phase: "Admission",
		remaining: normalized.budget.total,
		members,
		leaseHolders:
			managed.resolution.provisions.length > 0 && Option.isSome(current)
				? [current.value.id]
				: [],
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
		runtime,
		authorization,
		preparation,
		capacity,
		oldChanged: yield* TxRef.make(Option.isNone(current)),
		started: run.budget.started,
		request: normalized,
		status,
		cancelled: run.cancel,
		conditions:
			yield* TxRef.make<ReadonlyArray<ChangeTable.Condition>>(conditions),
		handle,
	}

	return record
})

export const admit = Effect.fnUntraced(function* (
	runtime: Runtime,
	request: Change.Request,
	normalized: Normalized,
	run: Run,
	preparation: Preparation,
	plan: Plan,
) {
	const table = runtime.changes
	const duplicate = yield* ChangeTable.duplicate(table, request.key, normalized)
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

	const selection = yield* select(runtime, normalized, preparation, plan)
	const { managed, current } = selection
	const sequence = yield* TxRef.get(table.next)
	const id = Change.Id.make(`change-${sequence}`)
	const premises = yield* reserve(runtime, normalized, selection, id, plan)
	const record = yield* makeRecord(
		runtime,
		request,
		normalized,
		run,
		preparation,
		selection,
		premises,
		id,
	)
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
			Option.getOrUndefined,
		),
	} as const
}, Effect.tx)
