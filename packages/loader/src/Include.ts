/**
 * Keeps entries in a YAML file. Edits are written back atomically with
 * formatting and comments preserved, and edits made to the file by hand are
 * picked up while the loader runs.
 */
import { Graft, Plugin } from "@graftland/graft"
import type { PlatformError } from "effect"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	FileSystem,
	HashSet,
	Option,
	Path,
	Record,
	Ref,
	Schema,
	Stream,
	SubscriptionRef,
} from "effect"
import {
	Document,
	isAlias,
	isNode,
	isMap,
	isSeq,
	parseDocument,
	visit,
	type Alias,
	type Node,
	type ScalarTag,
	type YAMLMap,
	type YAMLSeq,
} from "yaml"
import { isOnlyFailure } from "./internal/recovery"
import { equalConfig } from "./internal/equalConfig"
import { Entry, Env } from "./Entry"
import { newId, start, StoreError } from "./Loader"
import { fileTarget } from "./internal/fileTarget"
import { atomicWrite, WriteConflict } from "./internal/atomicWrite"
import {
	apply,
	InvalidOperation,
	Op,
	pathOf,
	validate,
	validateStructure,
	type Path as EntryPath,
} from "./Tree"

const envTag: ScalarTag = {
	tag: "!env",
	identify: (value) => value instanceof Env,
	resolve: (name) => new Env({ name }),
	stringify: (item) => (item.value as Env).name,
}

/** YAML is a synchronous boundary whose input errors must remain typed failures. */
const yaml = <A>(evaluate: () => A) =>
	Effect.try({ try: evaluate, catch: (cause) => StoreError.make({ cause }) })

const parse = (text: string) =>
	yaml(() => {
		const document = parseDocument(text, { customTags: [envTag] })
		const invalid = Array.head(document.errors)
		if (Option.isSome(invalid)) throw invalid.value
		return document
	})

const decodeEntries = (value: unknown) => Effect.fromResult(validate(value))

interface Synced {
	/** The file contents as last read or written. */
	readonly text: string
	readonly entries: ReadonlyArray<Entry>
}

/** The content and the physical pathname read in the same serialized operation. */
interface Loaded extends Synced {
	readonly target: string
}

const flatten = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> =>
	Array.flatMap(entries, (entry) => [
		entry,
		...(entry.group === true && Array.isArray(entry.config)
			? flatten(entry.config as ReadonlyArray<Entry>)
			: []),
	])

/** Normalize only entry/group boundaries; ordinary plugin config keeps its aliases. */
const normalizeGroups = (document: Document) => {
	let changed = false
	const materialize = (alias: Alias) => {
		const node = document.createNode(alias.toJS(document))
		if (alias.comment !== undefined) node.comment = alias.comment
		if (alias.commentBefore !== undefined)
			node.commentBefore = alias.commentBefore
		changed = true
		return node
	}
	const visit = (node: unknown): void => {
		if (!isSeq(node)) return
		node.items = Array.map(node.items, (entry) =>
			isAlias(entry) ? materialize(entry) : entry,
		)
		for (const entry of node.items) {
			if (!isMap(entry)) continue
			const id = entry.get("id")
			if (isAlias(id)) entry.set("id", materialize(id))
			const flag = entry.get("group")
			if ((isAlias(flag) ? flag.toJS(document) : flag) !== true) continue
			if (isAlias(flag)) {
				entry.set("group", true)
				changed = true
			}
			const config = entry.get("config")
			if (isAlias(config)) entry.set("config", materialize(config))
			visit(entry.get("config"))
		}
	}
	visit(document.contents)
	return changed
}

/**
 * Plans ids and the logical target without mutating YAML. An entry equal to one from the
 * previous version (same name and config) keeps that entry's id, so editing
 * an anonymous entry by hand does not restart it under a new identity.
 */
const planIds = (document: Document, previous: ReadonlyArray<Entry>) =>
	Effect.gen(function* () {
		const explicitIds = (node: unknown): ReadonlyArray<string> =>
			!isSeq(node)
				? []
				: Array.flatMap(node.items, (item) => {
						if (!isMap(item)) return []
						const id = item.get("id")
						return [
							...(typeof id === "string" ? [id] : []),
							...(item.get("group") === true
								? explicitIds(item.get("config"))
								: []),
						]
					})
		let used = HashSet.fromIterable(explicitIds(document.contents))
		let available = Array.filter(
			flatten(previous),
			(entry) => !HashSet.has(used, entry.id),
		)
		let assignments: ReadonlyArray<{
			readonly map: YAMLMap<unknown, unknown>
			readonly id: string
			readonly path: EntryPath
		}> = []
		// Build logical entries bottom-up. No YAML nodes change during matching,
		// so parent identity depends on restored child identities, not raw syntax.
		const visit = (
			node: unknown,
			path: EntryPath = [],
		): Effect.Effect<unknown, StoreError> =>
			Effect.gen(function* () {
				if (!isSeq(node))
					return yield* yaml(() =>
						isNode(node) ? node.toJS(document) : (node ?? []),
					)
				return yield* Effect.forEach(
					(node as YAMLSeq<unknown>).items,
					(item, index) =>
						Effect.gen(function* () {
							if (!isMap(item))
								return yield* yaml(() =>
									isNode(item) ? item.toJS(document) : item,
								)
							const map = item as YAMLMap<unknown, unknown>
							const raw = yield* yaml(
								() => map.toJS(document) as Record<string, unknown>,
							)
							const plain =
								map.get("group") === true
									? {
											...raw,
											config: yield* visit(map.get("config"), [
												...path,
												index,
												"config",
											]),
										}
									: raw
							if (map.has("id")) return plain
							const match = Array.findFirst(
								available,
								(entry) =>
									entry.name === plain["name"] &&
									equalConfig(entry.config, plain["config"]),
							)
							let id = Option.isSome(match) ? match.value.id : yield* newId
							while (HashSet.has(used, id)) id = yield* newId
							used = HashSet.add(used, id)
							available = Array.filter(available, (entry) => entry.id !== id)
							assignments = Array.append(assignments, {
								map,
								id,
								path: [...path, index],
							})
							return { ...plain, id }
						}),
				)
			})
		const target = yield* visit(document.contents)
		return { target, assignments }
	})

/** Materialize all affected references against the original graph before any mutation. */
const protectAliases = (
	document: Document,
	affected: WeakSet<Node>,
	removed = new WeakSet<Node>(),
) => {
	// YAML nodes are mutable identities, not structural Hash/Equal keys.
	const copies = new WeakMap<Alias, Node>()
	visit(document, {
		Alias: (_key, alias) => {
			if (removed.has(alias)) return
			const target = alias.resolve(document)
			if (target !== undefined && affected.has(target))
				copies.set(alias, copyAlias(document, alias))
		},
	})
	visit(document, {
		Alias: (_key, alias) => copies.get(alias),
	})
}

const copyAlias = (document: Document, alias: Alias) => {
	const copy = document.createNode(alias.toJS(document))
	if (alias.comment !== undefined) copy.comment = alias.comment
	if (alias.commentBefore !== undefined)
		copy.commentBefore = alias.commentBefore
	return copy
}

/** Detach aliases that would otherwise change value or lose their anchor during this edit. */
const detachAliases = (
	document: Document,
	entries: ReadonlyArray<Entry>,
	op: Op,
) => {
	const paths: ReadonlyArray<EntryPath> = Op.$match(op, {
		Create: ({ parent }) => [
			Option.match(parent, {
				onNone: () => [],
				onSome: (id) => [...Option.getOrThrow(pathOf(entries, id)), "config"],
			}),
		],
		Update: ({ id, patch }) => {
			const fields: Readonly<Record<string, unknown>> = patch
			return Array.map(Record.keys(fields), (key) => [
				...Option.getOrThrow(pathOf(entries, id)),
				key,
			])
		},
		Remove: ({ id }) => [Option.getOrThrow(pathOf(entries, id))],
	})

	// An edit through an alias changes its local copy, never the source collection.
	for (const path of paths) {
		const depth = op._tag === "Create" ? path.length : path.length - 1
		for (let length = 0; length <= depth; length++) {
			const prefix = path.slice(0, length)
			const node = document.getIn(prefix, true)
			if (isAlias(node)) document.setIn(prefix, copyAlias(document, node))
		}
	}
	const affected = new WeakSet<Node>()
	const removed = new WeakSet<Node>()
	for (const path of paths) {
		for (let length = 0; length <= path.length; length++) {
			const node = document.getIn(path.slice(0, length), true)
			if (isNode(node)) affected.add(node)
		}
		// Replacing a field or removing an entry also removes anchors nested inside it.
		if (op._tag !== "Create") {
			const node = document.getIn(path, true)
			if (isNode(node))
				visit(node, {
					Node: (_key, node) => {
						affected.add(node)
						removed.add(node)
					},
				})
		}
	}
	protectAliases(document, affected, removed)
}

/** Applies an edit to the document in place. The edit was already checked against the entries. */
const edit = (document: Document, entries: ReadonlyArray<Entry>, op: Op) =>
	Op.$match(op, {
		Create: ({ entry, parent, position }) => {
			const list: EntryPath = Option.match(parent, {
				onNone: () => [],
				onSome: (id) => [
					...Option.getOrElse(pathOf(entries, id), () => []),
					"config",
				],
			})
			if (list.length === 0 && !isSeq(document.contents))
				document.contents = document.createNode([])
			if (list.length > 0 && !isSeq(document.getIn(list, true)))
				document.setIn(list, document.createNode([]))
			const seq = (
				list.length > 0 ? document.getIn(list, true) : document.contents
			) as YAMLSeq<unknown>
			seq.items.splice(
				Option.getOrElse(position, () => seq.items.length),
				0,
				document.createNode(entry),
			)
		},
		Update: ({ id, patch }) => {
			const path = Option.getOrElse(pathOf(entries, id), () => [])
			for (const [key, value] of Record.toEntries(
				patch as Readonly<Record<string, unknown>>,
			)) {
				if (value === undefined) document.deleteIn([...path, key])
				else {
					const previous = document.getIn([...path, key], true)
					const next = document.createNode(value)
					if (isNode(previous)) {
						if (previous.comment !== undefined) next.comment = previous.comment
						if (previous.commentBefore !== undefined)
							next.commentBefore = previous.commentBefore
					}
					document.setIn([...path, key], next)
				}
			}
		},
		Remove: ({ id }) => {
			document.deleteIn(Option.getOrElse(pathOf(entries, id), () => []))
		},
	})

/** Whether an update touches a field that also changed on disk since the last sync. */
const conflicts = (
	op: Op,
	before: ReadonlyArray<Entry>,
	after: ReadonlyArray<Entry>,
) => {
	if (op._tag !== "Update") return false
	const find = (entries: ReadonlyArray<Entry>) =>
		Array.findFirst(flatten(entries), (entry) => entry.id === op.id)
	const was = find(before)
	const now = find(after)
	if (Option.isNone(was) || Option.isNone(now)) return false
	const field = (entry: Entry, key: string) =>
		Record.get(entry as Readonly<Record<string, unknown>>, key)
	return Array.some(
		Record.keys(op.patch as Readonly<Record<string, unknown>>),
		(key) => {
			const before = field(was.value, key)
			const after = field(now.value, key)
			return Option.isSome(before)
				? Option.isNone(after) || !equalConfig(before.value, after.value)
				: Option.isSome(after)
		},
	)
}

/** Retry only a lone version conflict; cleanup failures and interruptions remain intact. */
const retryWrite = <A, E, R>(
	effect: Effect.Effect<A, E | WriteConflict, R>,
) => {
	const attempt = (remaining: number): Effect.Effect<A, E | WriteConflict, R> =>
		effect.pipe(
			Effect.catchCause((cause) => {
				const conflict = isOnlyFailure(cause, Schema.is(WriteConflict))
				return conflict && remaining > 0
					? attempt(remaining - 1)
					: Effect.failCause(cause)
			}),
		)
	return attempt(2).pipe(
		Effect.mapError((cause) =>
			Schema.is(WriteConflict)(cause) ? StoreError.make({ cause }) : cause,
		),
	)
}

/** Parse, assign identities and verify serialization without touching the filesystem. */
const prepare = Effect.fnUntraced(function* (
	text: string,
	previous: ReadonlyArray<Entry>,
) {
	const document = yield* parse(text)
	const raw = yield* yaml(() => document.toJS())
	yield* Effect.fromResult(validateStructure(raw))
	const normalized = yield* yaml(() => normalizeGroups(document))
	const plan = yield* planIds(document, previous)
	const target = yield* decodeEntries(plan.target ?? [])
	yield* yaml(() => {
		const affected = new WeakSet<Node>()
		for (const { path } of plan.assignments) {
			for (let length = 0; length <= path.length; length++) {
				const node = document.getIn(path.slice(0, length), true)
				if (isNode(node)) affected.add(node)
			}
		}
		protectAliases(document, affected)
		for (const { map, id } of plan.assignments)
			map.items.unshift(document.createPair("id", id))
	})
	const changed = plan.assignments.length > 0 || normalized
	const synced = changed ? yield* yaml(() => document.toString()) : text
	const verified = yield* parse(synced)
	const value = yield* yaml(() => verified.toJS())
	const entries = yield* decodeEntries(value ?? [])
	if (!equalConfig(entries, target))
		return yield* StoreError.make({
			cause: new Error(
				"Serialized entries do not match the ID assignment target",
			),
		})
	return { text: synced, entries } satisfies Synced
})

const Config = Schema.Struct({
	path: Schema.String,
	/** Picks up changes made to the file while running. */
	watch: Schema.optionalKey(Schema.Boolean),
	/** Validated and assigned ids before creating a missing file. */
	initial: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})

export type Config = typeof Config.Type

export const Include: Plugin.Plugin<
	Config,
	Config,
	| Graft.ServiceConflict
	| PlatformError.PlatformError
	| Schema.SchemaError
	| StoreError
	| InvalidOperation
> = Plugin.make({
	name: "include",
	config: Config,
	inject: [FileSystem.FileSystem, Path.Path],
	apply: ({ path: file, watch, initial }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path

			const entry = path.resolve(file)
			const watchedTarget = yield* SubscriptionRef.make(entry)
			const resolveTarget = fileTarget(entry).pipe(
				Effect.provideService(FileSystem.FileSystem, fs),
				Effect.provideService(Path.Path, path),
				Effect.tap((target) => SubscriptionRef.set(watchedTarget, target)),
			)
			const write = (
				target: string,
				text: string,
				expected: Option.Option<string>,
			) =>
				atomicWrite(
					target,
					text,
					expected,
					Effect.flatMap(resolveTarget, (current) =>
						current === target
							? Effect.void
							: Effect.fail(WriteConflict.make({ path: entry })),
					),
				).pipe(Effect.provideService(FileSystem.FileSystem, fs))

			/** Persist only a fully prepared document at the target that supplied its contents. */
			const read = Effect.fnUntraced(function* (
				target: string,
				text: string,
				previous: ReadonlyArray<Entry>,
			) {
				const prepared = yield* prepare(text, previous)
				if (prepared.text !== text)
					yield* write(target, prepared.text, Option.some(text))
				return { ...prepared, target } satisfies Loaded
			})

			const initialize = retryWrite(
				Effect.gen(function* () {
					const target = yield* resolveTarget
					if (!(yield* fs.exists(target))) {
						const text = yield* yaml(() =>
							new Document(initial ?? [], { customTags: [envTag] }).toString(),
						)
						const prepared = yield* prepare(text, [])
						yield* write(target, prepared.text, Option.none())
						return Option.some({ ...prepared, target })
					}
					return yield* fs.readFileString(target).pipe(
						Effect.flatMap((contents) => read(target, contents, [])),
						Effect.asSome,
					)
				}),
			)
			const initialSynced = yield* watch === true
				? initialize.pipe(
						Effect.catchCauseIf(
							(cause) => !Cause.hasInterrupts(cause) && !Cause.hasDies(cause),
							(cause) =>
								Effect.logError(
									`Waiting for valid configuration in ${file}`,
									cause,
								).pipe(Effect.as(Option.none<Loaded>())),
						),
					)
				: initialize
			// None means no valid document has been loaded. Never treat invalid text
			// as an empty document: edits must successfully re-read it first.
			const synced = yield* Ref.make(initialSynced)
			const entriesOf = (snapshot: Option.Option<Loaded>) =>
				Option.match(snapshot, {
					onNone: () => [],
					onSome: (value) => value.entries,
				})

			// Loader owns serialization. Documents are local to a read or edit;
			// only the resolved path, text and entries are retained in the shared snapshot.
			const fresh = (previous: Option.Option<Loaded>) =>
				Effect.gen(function* () {
					const target = yield* resolveTarget
					const disk = yield* fs.readFileString(target)
					return Option.isSome(previous) &&
						target === previous.value.target &&
						disk === previous.value.text
						? previous.value
						: yield* read(target, disk, entriesOf(previous)).pipe(
								Effect.mapError((cause) =>
									Schema.is(StoreError)(cause) ||
									Schema.is(WriteConflict)(cause)
										? cause
										: StoreError.make({ cause }),
								),
							)
				})

			const applyOp = (op: Op) =>
				Effect.gen(function* () {
					const previous = yield* Ref.get(synced)
					// Keep the original baseline across retries to detect same-field edits.
					return yield* retryWrite(
						Effect.gen(function* () {
							const current = yield* fresh(previous)
							if (conflicts(op, entriesOf(previous), current.entries)) {
								yield* Effect.logWarning(
									`Dropped an edit to "${op._tag === "Update" ? op.id : ""}": the file changed it too`,
								)
								yield* Ref.set(synced, Option.some(current))
								return current.entries
							}
							const entries = yield* Effect.fromResult(
								apply(current.entries, op),
							)
							const document = yield* parse(current.text)
							const text = yield* yaml(() => {
								detachAliases(document, current.entries, op)
								edit(document, current.entries, op)
								return document.toString()
							})
							const verified = yield* parse(text)
							const value = yield* yaml(() => verified.toJS())
							const decoded = yield* decodeEntries(value).pipe(
								Effect.mapError((cause) => StoreError.make({ cause })),
							)
							if (!equalConfig(decoded, entries))
								return yield* StoreError.make({
									cause: new Error(
										"Serialized entries do not match the edited target",
									),
								})
							yield* write(current.target, text, Option.some(current.text))
							yield* Ref.set(
								synced,
								Option.some({ target: current.target, text, entries: decoded }),
							)
							return decoded
						}),
					)
				})

			const refresh = retryWrite(
				Effect.gen(function* () {
					const previous = yield* Ref.get(synced)
					const current = yield* fresh(previous)
					if (Option.isSome(previous) && current === previous.value)
						return Option.none<ReadonlyArray<Entry>>()
					yield* Ref.set(synced, Option.some(current))
					return Option.some(current.entries)
				}),
			)

			const notifications = (target: string) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const ready = yield* Deferred.make<void>()
						const events = fs
							.watch(path.dirname(target), {
								onReady: () => Deferred.doneUnsafe(ready, Effect.void),
							})
							.pipe(
								Stream.filter(
									(event) =>
										path.basename(event.path) === path.basename(target),
								),
								Stream.as(undefined),
							)
						// Observe again once installed, including changes made during a target switch.
						return Stream.merge(
							events,
							Stream.fromEffect(Deferred.await(ready)),
						)
					}),
				).pipe(
					Stream.catchCause((cause) =>
						Stream.fromEffect(
							Effect.logError(`Stopped watching ${target}`, cause).pipe(
								Effect.andThen(Effect.never),
							),
						),
					),
				)
			const external =
				watch === true
					? Stream.merge(
							notifications(entry),
							SubscriptionRef.changes(watchedTarget).pipe(
								Stream.changes,
								Stream.switchMap((target) =>
									target === entry ? Stream.never : notifications(target),
								),
							),
						).pipe(
							// Only refresh reads configuration, under Loader's lock.
							Stream.mapEffect(() => Effect.sleep("100 millis")),
						)
					: Stream.never

			yield* start({
				initial: entriesOf(initialSynced),
				apply: applyOp,
				refresh,
				external,
			})
		}),
})
