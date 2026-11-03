/**
 * Keeps entries in a YAML file. Edits are written back atomically with
 * formatting and comments preserved, and edits made to the file by hand are
 * picked up while the loader runs.
 */
import { Graft, Plugin } from "@nmnmcc/graft"
import type { PlatformError } from "effect"
import {
	Array as Arr,
	Deferred,
	Effect,
	Equal,
	FileSystem,
	Option,
	Path,
	Record,
	Result,
	Schema,
	Semaphore,
	Stream,
} from "effect"
import {
	Document,
	isMap,
	isSeq,
	parseDocument,
	type ScalarTag,
	type YAMLMap,
	type YAMLSeq,
	type YAMLError,
} from "yaml"
import { Entry, Env } from "./Entry"
import { newId, start } from "./Loader"
import { apply, Op, pathOf, type Path as EntryPath } from "./Tree"

const envTag: ScalarTag = {
	tag: "!env",
	identify: (value) => value instanceof Env,
	resolve: (name) => new Env({ name }),
	stringify: (item) => (item.value as Env).name,
}

const parse = (text: string) => parseDocument(text, { customTags: [envTag] })

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(Entry))

interface Synced {
	/** The file contents as last read or written. */
	readonly text: string
	readonly document: Document
	readonly entries: ReadonlyArray<Entry>
}

const flatten = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> =>
	Arr.flatMap(entries, (entry) => [
		entry,
		...(entry.group === true && Arr.isArray(entry.config)
			? flatten(entry.config as ReadonlyArray<Entry>)
			: []),
	])

/**
 * Gives every entry without an id one. An entry equal to one from the
 * previous version (same name and config) keeps that entry's id, so editing
 * an anonymous entry by hand does not restart it under a new identity.
 */
const assignIds = (document: Document, previous: ReadonlyArray<Entry>) =>
	Effect.gen(function* () {
		let available = flatten(previous)
		let assigned = false
		const visit = (node: unknown): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (!isSeq(node)) return
				for (const item of (node as YAMLSeq<unknown>).items) {
					if (!isMap(item)) continue
					const map = item as YAMLMap<unknown, unknown>
					if (!map.has("id")) {
						const plain = map.toJSON() as Record<string, unknown>
						const match = Arr.findFirst(
							available,
							(entry) =>
								entry.name === plain["name"] &&
								Equal.equals(entry.config, plain["config"]),
						)
						const id = Option.isSome(match) ? match.value.id : yield* newId
						available = Arr.filter(available, (entry) => entry.id !== id)
						map.items.unshift(document.createPair("id", id))
						assigned = true
					}
					if (map.get("group") === true) yield* visit(map.get("config"))
				}
			})
		yield* visit(document.contents)
		return assigned
	})

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
				else document.setIn([...path, key], value)
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
		Arr.findFirst(flatten(entries), (entry) => entry.id === op.id)
	const was = find(before)
	const now = find(after)
	if (Option.isNone(was) || Option.isNone(now)) return false
	const field = (entry: Entry, key: string) =>
		Record.get(entry as Readonly<Record<string, unknown>>, key)
	return Arr.some(
		Record.keys(op.patch as Readonly<Record<string, unknown>>),
		(key) => !Equal.equals(field(was.value, key), field(now.value, key)),
	)
}

const Config = Schema.Struct({
	path: Schema.String,
	/** Picks up changes made to the file while running. */
	watch: Schema.optionalKey(Schema.Boolean),
	/** Written to the file if it does not exist yet. */
	initial: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})

export type Config = typeof Config.Type

export const Include: Plugin.Plugin<
	Config,
	Config,
	| Graft.ServiceConflict
	| PlatformError.PlatformError
	| Schema.SchemaError
	| YAMLError
> = Plugin.make({
	name: "include",
	config: Config,
	inject: [FileSystem.FileSystem, Path.Path],
	apply: ({ path: file, watch, initial }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const lock = yield* Semaphore.make(1)

			const write = Effect.fnUntraced(function* (text: string) {
				const temporary = `${file}.${yield* newId}.tmp`
				yield* fs.writeFileString(temporary, text)
				yield* fs.rename(temporary, file)
			})

			/** Reads the file, assigning and persisting ids for new anonymous entries. */
			const read = Effect.fnUntraced(function* (
				text: string,
				previous: ReadonlyArray<Entry>,
			) {
				const document = parse(text)
				const invalid = Arr.head(document.errors)
				if (Option.isSome(invalid)) return yield* Effect.fail(invalid.value)
				const assigned = yield* assignIds(document, previous)
				const synced = assigned ? document.toString() : text
				if (assigned) yield* write(synced)
				const entries = yield* decodeEntries(document.toJS() ?? [])
				return { text: synced, document, entries } satisfies Synced
			})

			if (!(yield* fs.exists(file))) {
				yield* write(
					new Document(initial ?? [], { customTags: [envTag] }).toString(),
				)
			}
			const contents = yield* fs.readFileString(file)
			let synced = yield* read(contents, [])

			const applyOp = (op: Op) =>
				Semaphore.withPermits(
					lock,
					1,
				)(
					Effect.gen(function* () {
						const disk = yield* fs.readFileString(file)
						if (disk !== synced.text) {
							const fresh = yield* read(disk, synced.entries).pipe(Effect.orDie)
							if (conflicts(op, synced.entries, fresh.entries)) {
								yield* Effect.logWarning(
									`Dropped an edit to "${op._tag === "Update" ? op.id : ""}": the file changed it too`,
								)
								synced = fresh
								return fresh.entries
							}
							synced = fresh
						}
						const entries = yield* Effect.fromResult(apply(synced.entries, op))
						edit(synced.document, synced.entries, op)
						const text = synced.document.toString()
						yield* write(text)
						synced = { text, document: synced.document, entries }
						return entries
					}),
				)

			const external =
				watch === true
					? Stream.unwrap(
							Effect.gen(function* () {
								const ready = yield* Deferred.make<void>()
								const events = fs
									.watch(path.dirname(file), {
										onReady: () => Deferred.doneUnsafe(ready, Effect.void),
									})
									.pipe(
										Stream.filter(
											(event) =>
												path.basename(event.path) === path.basename(file),
										),
									)
								// Once the watcher is live, look once more: an edit made before then raised no event.
								return Stream.merge(
									Stream.as(events, undefined),
									Stream.fromEffect(Deferred.await(ready)),
								)
							}),
						).pipe(
							// Let a burst of writes settle; events that find nothing new are skipped.
							Stream.mapEffect(() =>
								Effect.andThen(
									Effect.sleep("100 millis"),
									Semaphore.withPermits(
										lock,
										1,
									)(
										Effect.gen(function* () {
											const disk = yield* fs.readFileString(file)
											if (disk === synced.text)
												return Option.none<ReadonlyArray<Entry>>()
											synced = yield* read(disk, synced.entries)
											return Option.some(synced.entries)
										}),
									).pipe(
										Effect.catchCause((cause) =>
											Effect.as(
												Effect.logError(
													`Ignoring an invalid edit to ${file}`,
													cause,
												),
												Option.none(),
											),
										),
									),
								),
							),
							Stream.filterMap((entries) =>
								Option.isSome(entries)
									? Result.succeed(entries.value)
									: Result.failVoid,
							),
							Stream.catchCause((cause) =>
								Stream.fromEffect(
									Effect.andThen(
										Effect.logError(`Stopped watching ${file}`, cause),
										Effect.never,
									),
								),
							),
						)
					: Stream.never

			yield* start({ initial: synced.entries, apply: applyOp, external })
		}),
})
