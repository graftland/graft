/**
 * `Graft.replace` in three steps: swap the plugins in one transaction, wait for
 * the forks running a replacement to settle, then keep the swap or roll it back
 * in one transaction.
 */
import {
	Array,
	Data,
	Duration,
	Effect,
	HashMap,
	HashSet,
	Option,
	Schema,
	TxRef,
	TxSubscriptionRef,
	type Cause,
} from "effect"

import type { Plugin } from "../Plugin"
import * as Aliases from "./aliases"
import type { ForkEntry, Runtime, Spec } from "./runtime"

/** The requested identities cannot be represented by the runtime's flat aliases. */
export class ReplacementConflict extends Schema.TaggedError<
	ReplacementConflict,
	{ readonly brand: unique symbol }
>()("ReplacementConflict", {
	indices: Schema.Array(Schema.Int),
}) {}

/** Why a replacement was rolled back: a fork running it failed or did not settle in time. */
export type ReplacementFailure = Data.TaggedEnum<{
	Failed: {
		readonly fork: number
		readonly plugin: string
		readonly cause: Cause.Cause<unknown>
	}
	TimedOut: { readonly fork: number; readonly plugin: string }
}>
export const ReplacementFailure = Data.taggedEnum<ReplacementFailure>()

/** The outcome of `Graft.replace`. */
export type ReplaceResult = Data.TaggedEnum<{
	/** Every fork running a replacement started, or is `Pending`. */
	Replaced: {}
	/** A fork running a replacement failed; every fork runs the old plugin again. */
	RolledBack: { readonly failures: ReadonlyArray<ReplacementFailure> }
}>
export const ReplaceResult = Data.taggedEnum<ReplaceResult>()

export interface ReplaceOptions {
	/** How long the replacements may take to start; unlimited when absent. */
	readonly timeout?: Duration.Input | undefined
}

type Pair = readonly [from: Plugin, to: Plugin]

/** The supervisor acts on a spec's plugin and revision; `update` may change its input. */
const sameSpec = (left: Spec, right: Spec) =>
	left.plugin === right.plugin && left.revision === right.revision

/** The plugin a replacement replaced, if `plugin` is one of the replacements. */
const originalOf = (pairs: ReadonlyArray<Pair>, plugin: Plugin) =>
	Option.map(
		Array.findFirst(pairs, ([from, to]) => from !== to && to === plugin),
		([from]) => from,
	)

interface Swapped {
	readonly undo: ReadonlyArray<Aliases.Write>
	/** Forks that had already failed; their outcome does not decide the rollback. */
	readonly failedBefore: HashSet.HashSet<number>
	/** The plugin each swapped fork ran before. */
	readonly originals: HashMap.HashMap<number, Plugin>
	/** Every fork that existed at the swap; the others were loaded since. */
	readonly existing: HashSet.HashSet<number>
	/** The revision each swapped fork got; a later replacement or restart moves it on. */
	readonly revisions: HashMap.HashMap<number, number>
}

const swap = (runtime: Runtime, pairs: ReadonlyArray<Pair>) =>
	Effect.tx(
		Effect.gen(function* () {
			const { conflicts, undo } = yield* Aliases.replace(runtime.aliases, pairs)
			if (conflicts.length > 0)
				return yield* ReplacementConflict.make({ indices: conflicts })
			const forks = yield* TxSubscriptionRef.get(runtime.forks)
			const swapped = yield* Effect.forEach(HashMap.values(forks), (entry) =>
				Effect.gen(function* () {
					const spec = yield* TxRef.get(entry.spec)
					const next = yield* Aliases.resolve(runtime.aliases, spec.plugin)
					if (next !== spec.plugin)
						yield* TxRef.set(entry.spec, {
							...spec,
							plugin: next,
							revision: spec.revision + 1,
						})
					const snapshot = yield* TxSubscriptionRef.get(entry.status.snapshot)
					return {
						id: entry.id,
						revision: spec.revision + 1,
						original: next === spec.plugin ? undefined : spec.plugin,
						failed: next !== spec.plugin && snapshot.state._tag === "Failed",
					}
				}),
			)
			const result: Swapped = {
				undo,
				failedBefore: HashSet.fromIterable(
					Array.flatMap(swapped, (fork) => (fork.failed ? [fork.id] : [])),
				),
				existing: HashSet.fromIterable(Array.map(swapped, (fork) => fork.id)),
				revisions: HashMap.fromIterable(
					Array.flatMap(swapped, (fork) =>
						fork.original === undefined
							? []
							: [[fork.id, fork.revision] as const],
					),
				),
				originals: HashMap.fromIterable(
					Array.flatMap(swapped, (fork) =>
						fork.original === undefined
							? []
							: [[fork.id, fork.original] as const],
					),
				),
			}
			return result
		}),
	)

type Verdict =
	| { readonly _tag: "Started" }
	| {
			readonly _tag: "Starting"
			readonly entry: ForkEntry
			readonly plugin: string
	  }
	| { readonly _tag: "Failed"; readonly failure: ReplacementFailure }

/**
 * Whether a fork's outcome decides the replacement: a fork the swap moved, or
 * one loaded since then that runs a replacement or sits below a moved fork,
 * such as a child that a replaced parent loads. Forks that already ran a
 * replacement before the swap, or that failed before it, do not decide.
 */
const judged = (
	forks: HashMap.HashMap<number, ForkEntry>,
	swapped: Swapped,
	moving: HashSet.HashSet<number>,
	entry: ForkEntry,
	spec: Spec,
	pairs: ReadonlyArray<Pair>,
): boolean => {
	if (HashSet.has(swapped.failedBefore, entry.id)) return false
	if (HashMap.has(swapped.originals, entry.id))
		return HashSet.has(moving, entry.id)
	if (HashSet.has(swapped.existing, entry.id)) return false
	// Loaded since by asking for a plugin this replacement replaced.
	if (asksForSource(pairs, spec)) return true
	for (
		let parent = entry.parent;
		parent !== undefined;
		parent = Option.getOrUndefined(HashMap.get(forks, parent))?.parent
	)
		if (HashSet.has(moving, parent)) return true
	return false
}

/** Whether a fork asked for one of the plugins these pairs replace, and got its replacement. */
const asksForSource = (pairs: ReadonlyArray<Pair>, spec: Spec) =>
	Option.exists(
		originalOf(pairs, spec.plugin),
		(from) => from === spec.requested,
	)

/**
 * Moved forks still on the revision this replacement gave them. A later
 * replacement or restart takes a fork over, with its children.
 */
const stillMoving = (
	forks: HashMap.HashMap<number, ForkEntry>,
	swapped: Swapped,
	pairs: ReadonlyArray<Pair>,
) =>
	Effect.map(
		Effect.forEach(HashMap.keys(swapped.originals), (id) =>
			Option.match(HashMap.get(forks, id), {
				onNone: () => Effect.succeed(Option.none<number>()),
				onSome: (entry) =>
					Effect.map(TxRef.get(entry.spec), (spec) =>
						Option.isSome(originalOf(pairs, spec.plugin)) &&
						Option.contains(HashMap.get(swapped.revisions, id), spec.revision)
							? Option.some(id)
							: Option.none(),
					),
			}),
		),
		(ids) => HashSet.fromIterable(Array.getSomes(ids)),
	)

/** Where each judged fork stands. Disposed forks have no verdict. */
const verdicts = (
	runtime: Runtime,
	pairs: ReadonlyArray<Pair>,
	swapped: Swapped,
) =>
	Effect.gen(function* () {
		const forks = yield* TxSubscriptionRef.get(runtime.forks)
		const moving = yield* stillMoving(forks, swapped, pairs)
		const all = yield* Effect.forEach(HashMap.values(forks), (entry) =>
			Effect.gen(function* () {
				const spec = yield* TxRef.get(entry.spec)
				if (!judged(forks, swapped, moving, entry, spec, pairs))
					return Option.none<Verdict>()
				const snapshot = yield* TxSubscriptionRef.get(entry.status.snapshot)
				if (snapshot.disposed) return Option.none<Verdict>()
				const current =
					snapshot.accepted !== undefined && sameSpec(snapshot.accepted, spec)
				if (!current || snapshot.state._tag === "Loading")
					return Option.some<Verdict>({
						_tag: "Starting",
						entry,
						plugin: spec.plugin.name,
					})
				return Option.some<Verdict>(
					snapshot.state._tag === "Failed"
						? {
								_tag: "Failed",
								failure: ReplacementFailure.Failed({
									fork: entry.id,
									plugin: spec.plugin.name,
									cause: snapshot.state.cause,
								}),
							}
						: { _tag: "Started" },
				)
			}),
		)
		return Array.getSomes(all)
	})

const failuresOf = (all: ReadonlyArray<Verdict>) =>
	Array.flatMap(all, (verdict) =>
		verdict._tag === "Failed" ? [verdict.failure] : [],
	)

/** Waits until a fork running a replacement fails, or all of them have started. */
const settle = (
	runtime: Runtime,
	pairs: ReadonlyArray<Pair>,
	swapped: Swapped,
) =>
	Effect.tx(
		Effect.gen(function* () {
			const all = yield* verdicts(runtime, pairs, swapped)
			const failures = failuresOf(all)
			if (failures.length > 0) return failures
			if (Array.some(all, (verdict) => verdict._tag === "Starting"))
				return yield* Effect.txRetry
			return failures
		}),
	)

/** The failures once the time is up: forks still starting count as timed out. */
const expired = (
	runtime: Runtime,
	pairs: ReadonlyArray<Pair>,
	swapped: Swapped,
) =>
	Effect.tx(
		Effect.map(verdicts(runtime, pairs, swapped), (all) =>
			Array.flatMap(all, (verdict): ReadonlyArray<ReplacementFailure> =>
				verdict._tag === "Failed"
					? [verdict.failure]
					: verdict._tag === "Starting"
						? [
								ReplacementFailure.TimedOut({
									fork: verdict.entry.id,
									plugin: verdict.plugin,
								}),
							]
						: [],
			),
		),
	)

/**
 * Points every fork still running a replacement back at what it ran before:
 * the plugin it was loaded with, through the restored aliases. Returns those
 * forks with the specs they now have.
 */
const rollBack = (
	runtime: Runtime,
	pairs: ReadonlyArray<Pair>,
	swapped: Swapped,
) =>
	Effect.tx(
		Effect.gen(function* () {
			yield* Aliases.restore(swapped.undo)
			const forks = yield* TxSubscriptionRef.get(runtime.forks)
			const moving = yield* stillMoving(forks, swapped, pairs)
			const reverted = yield* Effect.forEach(HashMap.values(forks), (entry) =>
				Effect.gen(function* () {
					const spec = yield* TxRef.get(entry.spec)
					const moved = HashMap.has(swapped.originals, entry.id)
					// Moved forks that nobody took over since, and forks loaded since by
					// asking for a replaced plugin. Every other fork stays as it is.
					if (
						moved
							? !HashSet.has(moving, entry.id)
							: HashSet.has(swapped.existing, entry.id) ||
								!asksForSource(pairs, spec)
					)
						return Option.none()
					const original = moved
						? Option.getOrElse(
								HashMap.get(swapped.originals, entry.id),
								() => spec.plugin,
							)
						: spec.requested
					const next: Spec = {
						...spec,
						plugin: original,
						revision: spec.revision + 1,
					}
					yield* TxRef.set(entry.spec, next)
					return Option.some({ entry, spec: next })
				}),
			)
			return Array.getSomes(reverted)
		}),
	)

/**
 * Waits until each reverted fork has restarted, whatever the outcome, so that
 * `RolledBack` means the old plugins run again. A fork that is disposed or
 * changed by someone else in the meantime no longer counts.
 */
const restarted = (
	reverted: ReadonlyArray<{ readonly entry: ForkEntry; readonly spec: Spec }>,
) =>
	Effect.tx(
		Effect.gen(function* () {
			const starting = yield* Effect.forEach(reverted, ({ entry, spec }) =>
				Effect.gen(function* () {
					const current = yield* TxRef.get(entry.spec)
					const snapshot = yield* TxSubscriptionRef.get(entry.status.snapshot)
					return (
						sameSpec(current, spec) &&
						!snapshot.disposed &&
						(snapshot.accepted === undefined ||
							!sameSpec(snapshot.accepted, spec) ||
							snapshot.state._tag === "Loading")
					)
				}),
			)
			if (Array.some(starting, (value) => value)) return yield* Effect.txRetry
		}),
	)

/**
 * Runs a replacement. A conflict fails before anything changes; otherwise the
 * result says whether the swap was kept. Interrupting the wait keeps the swap.
 */
export const replace = Effect.fnUntraced(function* (
	runtime: Runtime,
	pairs: ReadonlyArray<Pair>,
	options: ReplaceOptions | undefined,
) {
	const swapped = yield* swap(runtime, pairs)
	const waiting = settle(runtime, pairs, swapped)
	const timeout = options?.timeout
	const failures =
		timeout === undefined
			? yield* waiting
			: yield* Effect.timeoutOption(waiting, timeout).pipe(
					Effect.flatMap(
						Option.match({
							onSome: Effect.succeed,
							onNone: () => expired(runtime, pairs, swapped),
						}),
					),
				)
	if (failures.length === 0) return ReplaceResult.Replaced()
	const reverted = yield* rollBack(runtime, pairs, swapped)
	// Not bounded by `timeout`: `RolledBack` means the old plugins run again.
	yield* restarted(reverted)
	return ReplaceResult.RolledBack({ failures })
})
