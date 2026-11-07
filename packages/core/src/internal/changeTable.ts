import {
	Array,
	Cause,
	Effect,
	Equal,
	Exit,
	HashMap,
	HashSet,
	Option,
	Result,
	Scope,
	TxPubSub,
	TxRef,
} from "effect"

import * as Change from "../Change"
import * as Release from "../Release"
import * as Capacity from "./capacity"
import type { Preparation } from "./changePreparation"
import type { Normalized } from "./changeRequest"
import type { Runtime } from "./runtime"
import type { Classification } from "./terminalSettlement"
import type { HostLease } from "./transition"
import * as Trust from "./trust"

export interface Cell {
	readonly version: number
	readonly writer: Option.Option<Change.Id>
	readonly readers: HashSet.HashSet<Change.Id>
}
export interface Condition {
	readonly object: Change.ObjectKey
	readonly cell: TxRef.TxRef<Cell>
	readonly version: number
	readonly write: boolean
}
export interface Record {
	readonly obligations: TxRef.TxRef<ReadonlyArray<HostLease>>
	readonly runtime: Runtime
	readonly authorization: TxRef.TxRef<Trust.Condition>
	readonly preparation: Preparation
	readonly capacity: Capacity.Claim
	readonly oldChanged: TxRef.TxRef<boolean>
	readonly started: bigint
	readonly request: Normalized
	readonly status: TxRef.TxRef<Change.Status>
	readonly cancelled: TxRef.TxRef<boolean>
	readonly conditions: TxRef.TxRef<ReadonlyArray<Condition>>
	readonly handle: Change.Handle
}
export interface Table {
	readonly scope: Scope.Closeable
	readonly cleanupScope: Scope.Closeable
	readonly preparations: TxRef.TxRef<HashSet.HashSet<Effect.Effect<void>>>
	readonly open: TxRef.TxRef<boolean>
	readonly next: TxRef.TxRef<number>
	readonly objects: TxRef.TxRef<
		HashMap.HashMap<Change.ObjectKey, TxRef.TxRef<Cell>>
	>
	readonly records: TxRef.TxRef<HashMap.HashMap<Change.Id, Record>>
	readonly keys: TxRef.TxRef<HashMap.HashMap<string, Record>>
	readonly settled: TxRef.TxRef<ReadonlyArray<Change.Id>>
	readonly events: TxPubSub.TxPubSub<Change.Status>
}
export const make = Effect.gen(function* () {
	const scope = yield* Scope.make()
	const cleanupScope = yield* Scope.make()
	const preparations = yield* TxRef.make(HashSet.empty<Effect.Effect<void>>())
	yield* Scope.addFinalizer(
		scope,
		Effect.gen(function* () {
			const pending = yield* TxRef.get(preparations)
			const exits = yield* Effect.forEach(pending, Effect.exit, {
				concurrency: 8,
			})
			const released = yield* Effect.exit(
				Release.close(cleanupScope, Exit.void),
			)
			const cause = Array.reduce(
				[...exits, released],
				Cause.empty,
				(all: Cause.Cause<never>, exit) =>
					Exit.isFailure(exit) ? Cause.combine(all, exit.cause) : all,
			)
			if (cause.reasons.length > 0) return yield* Effect.failCause(cause)
		}),
	)
	return {
		scope,
		cleanupScope,
		preparations,
		open: yield* TxRef.make(true),
		next: yield* TxRef.make(1),
		objects: yield* TxRef.make(
			HashMap.empty<Change.ObjectKey, TxRef.TxRef<Cell>>(),
		),
		records: yield* TxRef.make(HashMap.empty<Change.Id, Record>()),
		keys: yield* TxRef.make(HashMap.empty<string, Record>()),
		settled: yield* TxRef.make<ReadonlyArray<Change.Id>>([]),
		events: yield* TxPubSub.sliding<Change.Status>(256),
	} satisfies Table
})

/** Object cells are tombstones for the runtime lifetime, so recreation cannot hide ABA. */
export const object = Effect.fnUntraced(function* (
	table: Table,
	key: Change.ObjectKey,
) {
	const objects = yield* TxRef.get(table.objects)
	const found = HashMap.get(objects, key)
	if (Option.isSome(found)) return found.value
	const cell = TxRef.makeUnsafe<Cell>({
		version: 0,
		writer: Option.none(),
		readers: HashSet.empty(),
	})
	yield* TxRef.set(table.objects, HashMap.set(objects, key, cell))
	return cell
})
export const bump = Effect.fnUntraced(function* (
	table: Table,
	key: Change.ObjectKey,
) {
	const cell = yield* object(table, key)
	const current = yield* TxRef.get(cell)
	yield* TxRef.set(cell, { ...current, version: current.version + 1 })
	return current.version + 1
})
export const duplicate = Effect.fnUntraced(function* (
	table: Table,
	key: string | undefined,
	request: Normalized,
) {
	if (key === undefined) return Option.none<Record>()
	const keys = yield* TxRef.get(table.keys)
	const found = HashMap.get(keys, key)
	if (Option.isSome(found) && !Equal.equals(found.value.request, request))
		return yield* Change.ChangeRejected.make({
			reason: { _tag: "KeyConflict", key },
		})
	return found
})

export const reserve = Effect.fnUntraced(function* (
	table: Table,
	id: Change.Id,
	objects: ReadonlyArray<{
		readonly object: Change.ObjectKey
		readonly write: boolean
	}>,
) {
	const conditions = yield* Effect.forEach(objects, (item) =>
		Effect.gen(function* () {
			const cell = yield* object(table, item.object)
			const current = yield* TxRef.get(cell)
			return { ...item, cell, version: current.version, current }
		}),
	)
	const conflicts = Array.filterMap(conditions, (c) => {
		const holders = Option.match(c.current.writer, {
			onNone: () => (c.write ? Array.fromIterable(c.current.readers) : []),
			onSome: (id) => [id],
		})
		return holders.length === 0
			? Result.fail(undefined)
			: Result.succeed({ object: c.object, holders })
	})
	if (conflicts.length > 0)
		return yield* Change.ChangeRejected.make({
			reason: { _tag: "Busy", conflicts },
		})
	for (const c of conditions)
		yield* TxRef.set(
			c.cell,
			c.write
				? { ...c.current, writer: Option.some(id) }
				: { ...c.current, readers: HashSet.add(c.current.readers, id) },
		)
	return conditions
})

const objectInvalidation = Effect.fnUntraced(function* (record: Record) {
	const conditions = yield* TxRef.get(record.conditions)
	for (const c of conditions) {
		const current = yield* TxRef.get(c.cell)
		if (
			current.version !== c.version ||
			!(c.write
				? Option.contains(current.writer, record.handle.id)
				: HashSet.has(current.readers, record.handle.id))
		)
			return Option.some(
				Cause.fail({
					object: c.object,
					expected: c.version,
					actual: current.version,
					reason: "Change premise no longer holds",
				}),
			)
	}
	return Option.none<Cause.Cause<unknown>>()
})
/** Recovery changes the execution target, never the reserved object ownership. */
export const authorizeRecovery = Effect.fnUntraced(function* (
	record: Record,
	identity: string,
) {
	const invalidation = yield* objectInvalidation(record)
	if (Option.isSome(invalidation)) return yield* Effect.fail(invalidation.value)
	const authorization = yield* Trust.snapshot(
		record.runtime,
		record.request.instance,
		identity,
	).pipe(Effect.mapError(Cause.fail))
	yield* TxRef.set(record.authorization, authorization)
}, Effect.tx)
export const invalidation = Effect.fnUntraced(function* (record: Record) {
	const condition = yield* TxRef.get(record.authorization)
	const authorization = yield* Effect.result(
		Trust.verify(record.runtime, condition),
	)
	return authorization._tag === "Failure"
		? Option.some(Cause.fail(authorization.failure))
		: yield* objectInvalidation(record)
})
export const valid = (record: Record) =>
	invalidation(record).pipe(Effect.map(Option.isNone))

/** Route commits modify only the instance cell; compatible facade bindings stay published. */
export const commit = Effect.fnUntraced(function* (record: Record) {
	if (!(yield* valid(record))) return false
	const conditions = yield* TxRef.get(record.conditions)
	const updated = yield* Effect.forEach(conditions, (c) =>
		Effect.gen(function* () {
			if (c.object._tag !== "Instance") return c
			const current = yield* TxRef.get(c.cell)
			yield* TxRef.set(c.cell, { ...current, version: current.version + 1 })
			return { ...c, version: current.version + 1 }
		}),
	)
	yield* TxRef.set(record.conditions, updated)
	return true
})
const release = Effect.fnUntraced(function* (record: Record) {
	yield* Capacity.release(record.capacity)
	const conditions = yield* TxRef.get(record.conditions)
	for (const c of conditions)
		yield* TxRef.update(c.cell, (state) => ({
			...state,
			writer: Option.contains(state.writer, record.handle.id)
				? Option.none()
				: state.writer,
			readers: HashSet.remove(state.readers, record.handle.id),
		}))
})
export const update = Effect.fnUntraced(function* (
	table: Table,
	record: Record,
	change: (status: Change.Status) => Change.Status,
) {
	const current = yield* TxRef.get(record.status)
	const next = { ...change(current), sequence: current.sequence + 1 }
	yield* TxRef.set(record.status, next)
	yield* TxPubSub.publish(table.events, next)
})
export const finish = Effect.fnUntraced(function* (
	table: Table,
	record: Record,
	outcome: Change.Outcome,
	settlement: Classification,
) {
	yield* update(table, record, (status) => ({
		...status,
		phase: outcome.phase,
		members: outcome.members,
		evidence: outcome.evidence,
		outcome: Option.some(outcome),
	}))
	return yield* retire(table, record, settlement)
})
const archive = Effect.fnUntraced(function* (table: Table, record: Record) {
	const existing = yield* TxRef.get(table.settled)
	if (Array.contains(existing, record.handle.id)) return
	const previous = yield* TxRef.get(table.settled)
	const history = Array.append(previous, record.handle.id)
	const evicted = Array.take(
		history,
		Math.max(0, history.length - Change.historyLimit),
	)
	yield* TxRef.set(table.settled, Array.takeRight(history, Change.historyLimit))
	for (const id of evicted)
		yield* TxRef.update(table.records, HashMap.remove(id))
})

/** All reservation release and history admission use the same authoritative obligation classification. */
export const retire = Effect.fnUntraced(function* (
	table: Table,
	record: Record,
	settlement: Classification,
) {
	if (settlement._tag === "Unresolved") return false
	yield* release(record)
	yield* archive(table, record)
	return true
})
