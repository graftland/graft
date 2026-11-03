/**
 * The loader keeps a tree of entries running and lets code edit it. Edits go
 * through a store, which may persist them, and the running tree is
 * reconciled to match.
 */
import { Graft, Plugin, type Fork } from "@graftland/graft"
import {
	Array as Arr,
	Context,
	Effect,
	Option,
	Random,
	Schema,
	Semaphore,
	Stream,
	String as Str,
	SubscriptionRef,
} from "effect"
import type { PlatformError } from "effect"
import { Entry } from "./Entry"
import { Group } from "./Group"
import { EntryNotFound, Op, apply, type Patch } from "./Tree"

export type NewEntry = Omit<Entry, "id"> & { readonly id?: string | undefined }

export class Loader extends Context.Service<
	Loader,
	{
		readonly entries: Effect.Effect<ReadonlyArray<Entry>>
		/** The current entries followed by every change. */
		readonly changes: Stream.Stream<ReadonlyArray<Entry>>
		/** The group fork that runs the whole tree. */
		readonly root: Fork.Fork
		/** Loads again every entry whose plugin or config could not be resolved, such as after fixing its module. */
		readonly retry: Effect.Effect<void>
		/** Waits until no fork in the tree is still loading. */
		readonly ready: Effect.Effect<void>
		/** Adds an entry, at the end of the root list unless told otherwise, and returns its id. */
		readonly create: (
			entry: NewEntry,
			options?: {
				readonly parent?: string | undefined
				readonly position?: number | undefined
			},
		) => Effect.Effect<string, EntryNotFound | PlatformError.PlatformError>
		readonly update: (
			id: string,
			patch: Patch,
		) => Effect.Effect<void, EntryNotFound | PlatformError.PlatformError>
		readonly remove: (
			id: string,
		) => Effect.Effect<void, EntryNotFound | PlatformError.PlatformError>
	}
>()("@graftland/loader/Loader") {}

/** Where the entries live. */
export interface Store {
	readonly initial: ReadonlyArray<Entry>
	/** Applies an edit, persisting it if the store does, and returns the resulting entries. */
	readonly apply: (
		op: Op,
	) => Effect.Effect<
		ReadonlyArray<Entry>,
		EntryNotFound | PlatformError.PlatformError
	>
	/** Entries changed by someone else, such as a person editing the config file. */
	readonly external: Stream.Stream<ReadonlyArray<Entry>>
}

/** A short random id for an entry that has none. */
export const newId = Effect.map(Random.nextIntBetween(0, 0xffffffff), (n) =>
	Str.padStart(8, "0")(n.toString(16)),
)

const settled = (trees: ReadonlyArray<Fork.ForkTree>, id: number): boolean => {
	const find = (
		nodes: ReadonlyArray<Fork.ForkTree>,
	): Option.Option<Fork.ForkTree> =>
		Arr.findFirst(nodes, (node) =>
			node.id === id ? Option.some(node) : find(node.children),
		)
	const loading = (node: Fork.ForkTree): boolean =>
		node.state._tag === "Loading" || Arr.some(node.children, loading)
	return Option.match(find(trees), {
		onNone: () => true,
		onSome: (node) => !loading(node),
	})
}

/** Runs the entries of a store under a root group and publishes the `Loader` service. */
export const start = Effect.fnUntraced(function* (store: Store) {
	const tree = yield* SubscriptionRef.make(store.initial)
	const root = yield* Graft.plugin(Group, store.initial)
	const lock = yield* Semaphore.make(1)
	const sync = (next: ReadonlyArray<Entry>) =>
		Effect.andThen(SubscriptionRef.set(tree, next), root.update(next))
	const edit = (op: Op) =>
		Semaphore.withPermits(lock, 1)(Effect.flatMap(store.apply(op), sync))
	yield* store.external.pipe(
		Stream.runForEach((next) => Semaphore.withPermits(lock, 1)(sync(next))),
		Effect.forkScoped,
	)
	const graft = yield* Graft.Graft
	const ready = Graft.forks.pipe(
		Stream.filter((trees) => settled(trees, root.id)),
		Stream.runHead,
		Effect.asVoid,
	)
	yield* Graft.provide(Loader, {
		entries: SubscriptionRef.get(tree),
		changes: SubscriptionRef.changes(tree),
		root,
		retry: Semaphore.withPermits(
			lock,
			1,
		)(Effect.flatMap(SubscriptionRef.get(tree), root.update)),
		ready: Effect.provideService(ready, Graft.Graft, graft),
		create: (entry, options) =>
			Effect.gen(function* () {
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
	name: "loader",
	config: Schema.Array(Entry),
	apply: (entries) =>
		Effect.gen(function* () {
			const current = yield* SubscriptionRef.make(entries)
			yield* start({
				initial: entries,
				apply: (op) =>
					SubscriptionRef.get(current).pipe(
						Effect.flatMap((tree) => Effect.fromResult(apply(tree, op))),
						Effect.tap((next) => SubscriptionRef.set(current, next)),
					),
				external: Stream.never,
			})
		}),
})
