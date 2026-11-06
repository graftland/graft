/**
 * The loader keeps a tree of entries running and lets code edit it. Edits go
 * through a store, which may persist them, and the running tree is
 * reconciled to match. Admitted edits belong to the loader's scope, so a caller
 * cancelling its wait cannot interrupt persistence or reconciliation.
 */
import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Equal,
	Exit,
	HashMap,
	Option,
	Queue,
	Random,
	Ref,
	Schema,
	Semaphore,
	Stream,
	String,
	SubscriptionRef,
	type PlatformError,
} from "effect"

import { Graft, Plugin, type Fork } from "@graftland/graft"

import { Entry, type NewEntry } from "./Entry"
import { Group } from "./Group"
import { EntryLists, type Lists } from "./internal/entryLists"
import { PendingRefreshes } from "./internal/pending"
import { nextEpoch, withEpoch } from "./internal/refresh"
import { snapshot } from "./internal/snapshot"
import { copyGroup } from "./internal/validated"
import {
	apply,
	EntryNotFound,
	InvalidOperation,
	Op,
	validate,
	type Patch,
} from "./Tree"

/** A store could not decode or serialize its contents. The original error is retained. */
export class StoreError extends Schema.TaggedError<
	StoreError,
	{ readonly brand: unique symbol }
>()("StoreError", { cause: Schema.Unknown }) {}

export type EditError =
	| EntryNotFound
	| InvalidOperation
	| PlatformError.PlatformError
	| StoreError
	| LoaderClosed

export class LoaderClosed extends Schema.TaggedError<
	LoaderClosed,
	{ readonly brand: unique symbol }
>()("LoaderClosed", {}) {}

export class Loader extends Context.Service<
	Loader,
	{
		/** The frozen persisted target. Arrays/plain records are owned; opaque instances retain identity. */
		readonly entries: Effect.Effect<ReadonlyArray<Entry>>
		/** Frozen persisted targets, starting with the current one. Use ready to wait for the runtime. */
		readonly changes: Stream.Stream<ReadonlyArray<Entry>>
		/** The group fork that runs the whole tree. */
		readonly root: Fork.Fork
		/**
		 * Requests reconciliation to retry every failed entry, including resolution and
		 * plugin activation. Healthy instances and unfinished resolution are retained. The whole tree
		 * rereads its environment; ordinary edits only reconcile changed entries.
		 * Returns after publishing the target; use ready to await reconciliation.
		 */
		readonly retry: Effect.Effect<void>
		/**
		 * Waits for the current target and every descendant, including module resolution,
		 * to leave Loading, for discovered entry-list ids to finish persistence,
		 * and for entries that were loading during a retry to read
		 * their environment again. Failed and Pending count as settled; cleanup success
		 * is not guaranteed. Do not await inside a lifecycle callback.
		 */
		readonly ready: Effect.Effect<void>
		/** Captures input before offering the edit; once queued, edits finish even if their caller stops waiting. */
		readonly create: (
			entry: NewEntry,
			options?: {
				readonly parent?: string | undefined
				readonly position?: number | undefined
			},
		) => Effect.Effect<string, EditError>
		readonly update: (
			id: string,
			patch: Patch,
		) => Effect.Effect<void, EditError>
		readonly remove: (id: string) => Effect.Effect<void, EditError>
	}
>()("@graftland/loader/Loader") {}

/**
 * Where the entries live. Loader serializes apply and refresh through publishing
 * their targets under one lock. Reconciliation runs independently; a store must
 * not update its state from the notification stream. Callback invocation and
 * refresh evaluation are deferred inside the lock and failure boundary. Even
 * synchronous defects complete the edit's reply and leave later edits runnable.
 */
export interface Store {
	/** Persist missing ids in discovered plugin entry lists under the store lock.
	 * Each path starts at config; "*" selects every array element or record value.
	 */
	readonly identify?: (
		lists: HashMap.HashMap<string, ReadonlyArray<ReadonlyArray<string>>>,
	) => Effect.Effect<Option.Option<ReadonlyArray<Entry>>, EditError>
	readonly initial: ReadonlyArray<Entry>
	/** Receives captured edit data, persists it, and returns a target that Loader snapshots before publication. */
	readonly apply: (op: Op) => Effect.Effect<ReadonlyArray<Entry>, EditError>
	/**
	 * Reads external changes and commits the store's new snapshot. None means
	 * nothing changed. Failures leave the last successful snapshot intact; Loader
	 * logs their full cause and continues listening for subsequent notifications.
	 */
	readonly refresh: Effect.Effect<
		Option.Option<ReadonlyArray<Entry>>,
		EditError
	>
	/** Notifications that entries may have changed. Reading and updating state belongs in refresh. */
	readonly external: Stream.Stream<void>
}

/** A short random id for an entry that has none. */
export const newId = Effect.map(Random.nextIntBetween(0, 0xffffffff), (n) =>
	String.padStart(8, "0")(n.toString(16)),
)

/** Runs the entries of a store under a root group and publishes the `Loader` service. */
export const start = Effect.fnUntraced(function* (store: Store) {
	const initial = yield* Effect.fromResult(validate(store.initial))
	const state = yield* SubscriptionRef.make({
		entries: initial,
		version: 0,
		reconciled: 0,
		epoch: nextEpoch(),
	})
	const pending = yield* SubscriptionRef.make(0)
	const lists = yield* SubscriptionRef.make<Lists>(HashMap.empty())
	const identified = yield* SubscriptionRef.make<Lists>(HashMap.empty())
	// Groups load their children here, so every nested group reports to it too.
	const initialState = yield* SubscriptionRef.get(state)
	const root = yield* Graft.plugin(
		Group,
		withEpoch(copyGroup(initial), initialState.epoch),
	).pipe(
		Effect.provideService(PendingRefreshes, Option.some(pending)),
		Effect.provideService(
			EntryLists,
			Option.some((name, locators) =>
				SubscriptionRef.update(lists, (current) =>
					locators.length === 0 && !HashMap.has(current, name)
						? current
						: HashMap.set(current, name, locators),
				),
			),
		),
	)
	const lock = yield* Semaphore.make(1)
	const publish = (entries: ReadonlyArray<Entry>) =>
		Effect.flatMap(Effect.fromResult(validate(entries)), (target) =>
			SubscriptionRef.update(state, (current) => ({
				...current,
				entries: target,
				version: current.version + 1,
			})),
		)
	yield* SubscriptionRef.changes(state).pipe(
		Stream.map((current) => current.version),
		Stream.changes,
		Stream.buffer({ capacity: 1, strategy: "sliding" }),
		Stream.runForEach(
			Effect.fnUntraced(
				function* () {
					const target = yield* SubscriptionRef.get(state)
					if (target.version === target.reconciled) return
					yield* root.update(withEpoch(copyGroup(target.entries), target.epoch))
					yield* SubscriptionRef.update(state, (current) => ({
						...current,
						reconciled: target.version,
					}))
				},
				Effect.catchCause((cause) =>
					Effect.logError("Reconciling loader entries failed", cause),
				),
			),
		),
		Effect.forkScoped,
	)
	const edits = yield* Queue.bounded<
		{
			readonly op: Op
			readonly reply: Deferred.Deferred<void, EditError>
		},
		Cause.Done
	>(1)
	yield* Stream.fromQueue(edits).pipe(
		Stream.runForEach(({ op, reply }) =>
			Semaphore.withPermits(
				lock,
				1,
			)(
				Effect.flatMap(
					Effect.suspend(() => store.apply(op)),
					publish,
				),
			).pipe(
				Effect.onExit((exit) => Deferred.done(reply, exit)),
				Effect.catchCause((cause) =>
					Effect.logError("Applying a loader edit failed", cause),
				),
			),
		),
		Effect.forkScoped,
	)
	yield* Effect.addFinalizer(
		Effect.fnUntraced(function* () {
			// End admission, then settle buffered jobs and offers already waiting for space.
			yield* Queue.end(edits)
			const pending = yield* Queue.collect(edits)
			yield* Effect.forEach(
				pending,
				({ reply }) => Deferred.done(reply, Exit.fail(LoaderClosed.make())),
				{ discard: true },
			)
		}),
	)
	const edit = Effect.fnUntraced(function* (op: Op) {
		// Capture before offering: the queue and worker must never retain caller-owned data.
		const captured = Op.$match(op, {
			Create: (create) =>
				Op.Create({ ...create, entry: snapshot(create.entry) }),
			Update: (update) =>
				Op.Update({ ...update, patch: snapshot(update.patch) }),
			Remove: (remove) => Op.Remove(remove),
		})
		const reply = yield* Deferred.make<void, EditError>()
		const accepted = yield* Queue.offer(edits, { op: captured, reply })
		if (!accepted) return yield* LoaderClosed.make()
		return yield* Deferred.await(reply)
	})
	const refresh = (
		operation: Effect.Effect<Option.Option<ReadonlyArray<Entry>>, EditError>,
		after: Effect.Effect<void> = Effect.void,
	) =>
		Semaphore.withPermits(
			lock,
			1,
		)(
			operation.pipe(
				Effect.flatMap(
					Option.match({ onNone: () => Effect.void, onSome: publish }),
				),
				Effect.catchCause((cause) =>
					Effect.logError("Refreshing loader entries failed", cause),
				),
				Effect.ensuring(after),
			),
		)
	yield* Stream.merge(
		Stream.suspend(() => store.external).pipe(
			Stream.map(() => refresh(Effect.suspend(() => store.refresh))),
		),
		SubscriptionRef.changes(lists).pipe(
			Stream.changes,
			Stream.map((known) =>
				refresh(
					Effect.suspend(() =>
						HashMap.size(known) === 0
							? Effect.succeedNone
							: (store.identify?.(known) ?? Effect.succeedNone),
					),
					SubscriptionRef.set(identified, known),
				),
			),
		),
	).pipe(
		Stream.runForEach((operation) => operation),
		Effect.catchCause((cause) =>
			Effect.logError("Loader change notifications stopped", cause),
		),
		Effect.forkScoped,
	)
	// Wake on target, refresh and identity persistence changes; avoid rendering the fork tree.
	const ready = Stream.mergeAll(
		[
			Stream.as(SubscriptionRef.changes(state), undefined),
			Stream.as(SubscriptionRef.changes(pending), undefined),
			Stream.as(SubscriptionRef.changes(identified), undefined),
		],
		{ concurrency: "unbounded" },
	).pipe(
		Stream.filterEffect(
			Effect.fnUntraced(function* () {
				const before = yield* SubscriptionRef.get(state)
				const known = yield* SubscriptionRef.get(lists)
				const written = yield* SubscriptionRef.get(identified)
				if (!Equal.equals(known, written)) return false
				if (before.version !== before.reconciled) return false
				if ((yield* SubscriptionRef.get(pending)) > 0) return false
				yield* root.stable
				// A refresh ends only after its fork's new state is published, so a zero
				// count read after the subtree settled cannot hide a later Loading fork.
				const refreshing = yield* SubscriptionRef.get(pending)
				const after = yield* SubscriptionRef.get(state)
				const latest = yield* SubscriptionRef.get(lists)
				const completed = yield* SubscriptionRef.get(identified)
				return (
					after.version === before.version &&
					refreshing === 0 &&
					Equal.equals(latest, completed)
				)
			}),
		),
		Stream.runHead,
		Effect.asVoid,
	)
	yield* Graft.provide(Loader, {
		entries: Effect.map(
			SubscriptionRef.get(state),
			(current) => current.entries,
		),
		changes: SubscriptionRef.changes(state).pipe(
			Stream.changesWith((before, after) => before.version === after.version),
			Stream.map((current) => current.entries),
		),
		root: {
			...root,
			// The public method always refreshes, even when given a runtime
			// snapshot carrying an earlier internal request's epoch.
			update: (entries) =>
				Effect.suspend(() =>
					root.update(
						Array.isArray(entries)
							? withEpoch(
									copyGroup(entries as ReadonlyArray<Entry>),
									nextEpoch(),
								)
							: entries,
					),
				),
		},
		retry: Semaphore.withPermits(
			lock,
			1,
		)(
			SubscriptionRef.update(state, (current) => ({
				...current,
				version: current.version + 1,
				epoch: nextEpoch(),
			})),
		),
		ready,
		create: Effect.fnUntraced(function* (entry, options) {
			const id = entry.id ?? (yield* newId)
			yield* edit(
				Op.Create({
					entry: { ...entry, id },
					parent: Option.fromUndefinedOr(options?.parent),
					position: Option.fromUndefinedOr(options?.position),
				}),
			)
			return id
		}),
		update: (id, patch) => edit(Op.Update({ id, patch })),
		remove: (id) => edit(Op.Remove({ id })),
	})
})

/** Loads entries kept in memory; edits are not persisted. */
export const plugin = Plugin.make({
	name: "@graftland/loader/Loader",
	config: Schema.Array(Entry),
	apply: Effect.fnUntraced(function* (entries) {
		const initial = snapshot(entries)
		const current = yield* Ref.make(initial)
		yield* start({
			initial,
			apply: (op) =>
				Ref.get(current).pipe(
					Effect.flatMap((tree) => Effect.fromResult(apply(tree, op))),
					Effect.tap((next) => Ref.set(current, next)),
				),
			refresh: Effect.succeedNone,
			external: Stream.never,
		})
	}),
})
