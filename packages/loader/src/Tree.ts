/**
 * Pure operations on a tree of entries. A group's children live in its
 * `config`, so a path alternates between list indices and `"config"`.
 */
import {
	Array,
	Data,
	HashSet,
	Option,
	Predicate,
	Record,
	Result,
	Schema,
} from "effect"
import { Entry } from "./Entry"
import { snapshot } from "./internal/snapshot"

export type Path = ReadonlyArray<string | number>

export class EntryNotFound extends Schema.TaggedError<
	EntryNotFound,
	{ readonly brand: unique symbol }
>()("EntryNotFound", { id: Schema.String }) {
	override get message(): string {
		return `No entry with id "${this.id}"`
	}
}

export class InvalidOperation extends Schema.TaggedError<
	InvalidOperation,
	{ readonly brand: unique symbol }
>()("InvalidOperation", {
	reason: Schema.String,
	cause: Schema.optionalKey(Schema.Unknown),
}) {
	override get message(): string {
		return this.reason
	}
}

/** Fields of an entry other than its id; `undefined` removes an optional field. */
export type Patch = {
	readonly [K in Exclude<keyof typeof Entry.schema.Type, "id">]?:
		Entry[K] | undefined
} & Readonly<Record<string, unknown>> & { readonly id?: never }

export type Op = Data.TaggedEnum<{
	Create: {
		readonly entry: Entry
		readonly parent: Option.Option<string>
		readonly position: Option.Option<number>
	}
	Update: { readonly id: string; readonly patch: Patch }
	Remove: { readonly id: string }
}>

export const Op = Data.taggedEnum<Op>()

/** The children of a group entry, or `None` for an ordinary entry. */
export const childrenOf = (
	entry: Entry,
): Option.Option<ReadonlyArray<Entry>> =>
	entry.group === true
		? Option.some(
				Array.isArray(entry.config)
					? (entry.config as ReadonlyArray<Entry>)
					: [],
			)
		: Option.none()

/** Where an entry sits in the tree. */
export const pathOf = (
	entries: ReadonlyArray<Entry>,
	id: string,
	prefix: Path = [],
): Option.Option<Path> => {
	for (const [index, entry] of entries.entries()) {
		if (entry.id === id) return Option.some([...prefix, index])
		const found = Option.flatMap(childrenOf(entry), (children) =>
			pathOf(children, id, [...prefix, index, "config"]),
		)
		if (Option.isSome(found)) return found
	}
	return Option.none()
}

/** Every id in the tree, depth first. */
export const ids = (entries: ReadonlyArray<Entry>): ReadonlyArray<string> =>
	Array.flatMap(entries, (entry) => [
		entry.id,
		...Option.match(childrenOf(entry), { onNone: () => [], onSome: ids }),
	])

/** Validate the entry/group topology before assigning ids or traversing the domain tree. */
export const validateStructure = (
	value: unknown,
): Result.Result<void, InvalidOperation> => {
	const finished = new WeakSet<object>()
	const visit = (
		value: unknown,
		ancestors: ReadonlyArray<unknown>,
	): Result.Result<void, InvalidOperation> => {
		if (!Array.isArray(value)) return Result.succeed(undefined)
		if (Array.some(ancestors, (ancestor) => ancestor === value))
			return Result.fail(
				InvalidOperation.make({
					reason: "Group entries must not form a cycle",
				}),
			)
		if (finished.has(value)) return Result.succeed(undefined)
		for (const entry of value) {
			if (
				!Predicate.hasProperty(entry, "group") ||
				entry.group !== true ||
				!Predicate.hasProperty(entry, "config")
			)
				continue
			const result = visit(entry.config, [...ancestors, value])
			if (Result.isFailure(result)) return result
		}
		finished.add(value)
		return Result.succeed(undefined)
	}
	return visit(value, [])
}

/** Check one list of ids, optionally continuing a whole-tree uniqueness check. */
export const validateIds = (
	entries: ReadonlyArray<Pick<Entry, "id">>,
	seen: HashSet.HashSet<string> = HashSet.empty(),
): Result.Result<HashSet.HashSet<string>, InvalidOperation> => {
	let unique = seen
	for (const entry of entries) {
		if (HashSet.has(unique, entry.id))
			return Result.fail(
				InvalidOperation.make({ reason: `Duplicate entry id "${entry.id}"` }),
			)
		unique = HashSet.add(unique, entry.id)
	}
	return Result.succeed(unique)
}

/** The schema and identity boundary of a single group, without inspecting descendants. */
export const GroupEntries = Schema.Array(Entry).check(
	Schema.makeFilter((entries) => {
		const checked = validateIds(entries)
		return Result.isFailure(checked) ? checked.failure.reason : undefined
	}),
)

const decodeGroup = (value: unknown) =>
	Result.mapError(Schema.decodeUnknownResult(GroupEntries)(value), (cause) =>
		InvalidOperation.make({
			reason: "Expected an array of valid entries",
			cause,
		}),
	)

/** Check topology, then decode only this group; descendants own their schema failures. */
export const validateGroup = (value: unknown) =>
	Result.flatMap(validateStructure(value), () =>
		Result.map(decodeGroup(value), (entries) =>
			snapshot(
				Array.map(entries, (entry) =>
					entry.group === true && entry.config === undefined
						? { ...entry, config: [] }
						: entry,
				),
			),
		),
	)

/**
 * Decode the whole tree after checking its topology. Unknown entry metadata is
 * retained, missing group config becomes [], and ids are unique across groups.
 * Ordinary plugin config remains opaque until its own activation prepares it.
 */
export const validate = (
	value: unknown,
): Result.Result<ReadonlyArray<Entry>, InvalidOperation> => {
	const structure = validateStructure(value)
	if (Result.isFailure(structure)) return Result.fail(structure.failure)
	let seen = HashSet.empty<string>()
	const visit = (
		value: unknown,
	): Result.Result<ReadonlyArray<Entry>, InvalidOperation> =>
		Result.gen(function* () {
			const list = yield* decodeGroup(value)
			seen = yield* validateIds(list, seen)
			let entries: ReadonlyArray<Entry> = []
			for (const entry of list) {
				entries = Array.append(
					entries,
					entry.group === true
						? {
								...entry,
								config: yield* visit(
									entry.config === undefined ? [] : entry.config,
								),
							}
						: entry,
				)
			}
			return entries
		})
	return Result.map(visit(value), snapshot)
}

const entryAt = (entries: ReadonlyArray<Entry>, path: Path): Entry => {
	const entry = entries[path[0] as number]!
	return path.length === 1
		? entry
		: entryAt(
				Option.getOrElse(childrenOf(entry), () => []),
				path.slice(2),
			)
}

/** Replaces the list at `path` (the root list for `[]`), keeping everything else. */
const modifyList = (
	entries: ReadonlyArray<Entry>,
	path: Path,
	f: (list: ReadonlyArray<Entry>) => ReadonlyArray<Entry>,
): ReadonlyArray<Entry> => {
	const [index, , ...rest] = path
	if (index === undefined) return f(entries)
	return Array.map(entries, (entry, i) =>
		i === index
			? {
					...entry,
					config: modifyList(
						Option.getOrElse(childrenOf(entry), () => []),
						rest,
						f,
					),
				}
			: entry,
	)
}

const decodeEntry = Schema.decodeUnknownResult(Entry)

const updateEntry = (entry: Entry, patch: Patch) => {
	const fields: Readonly<Record<string, unknown>> = { ...entry, ...patch }
	return Result.mapError(
		decodeEntry(
			Record.filter(fields, (value) => !Predicate.isUndefined(value)),
		),
		(cause) =>
			InvalidOperation.make({
				reason: "An edit must preserve the entry schema",
				cause,
			}),
	)
}

const applyUnchecked = (
	entries: ReadonlyArray<Entry>,
	op: Op,
): Result.Result<ReadonlyArray<Entry>, EntryNotFound | InvalidOperation> =>
	Op.$match(op, {
		Create: ({ entry, parent, position }) => {
			if (
				Option.isSome(position) &&
				(!Number.isInteger(position.value) || position.value < 0)
			)
				return Result.fail(
					InvalidOperation.make({
						reason: "Insertion position must be a non-negative integer",
					}),
				)
			if (Option.isSome(parent)) {
				const path = pathOf(entries, parent.value)
				if (Option.isSome(path) && entryAt(entries, path.value).group !== true)
					return Result.fail(
						InvalidOperation.make({
							reason: `Entry "${parent.value}" is not a group`,
						}),
					)
			}
			const parentPath = Option.match(parent, {
				onNone: () => Option.some<Path>([]),
				onSome: (id) =>
					Option.map(pathOf(entries, id), (path) => [...path, "config"]),
			})
			return Option.match(parentPath, {
				onNone: () =>
					Result.fail(
						EntryNotFound.make({ id: Option.getOrElse(parent, () => "") }),
					),
				onSome: (path) =>
					Result.succeed(
						modifyList(entries, path, (list) =>
							Array.insertAt(
								list,
								Option.getOrElse(position, () => list.length),
								entry,
							).pipe(Option.getOrElse(() => Array.append(list, entry))),
						),
					),
			})
		},
		Update: ({ id, patch }) =>
			Option.match(pathOf(entries, id), {
				onNone: () => Result.fail(EntryNotFound.make({ id })),
				onSome: (path) =>
					Result.map(updateEntry(entryAt(entries, path), patch), (updated) =>
						modifyList(entries, path.slice(0, -1), (list) =>
							Array.map(list, (entry) => (entry.id === id ? updated : entry)),
						),
					),
			}),
		Remove: ({ id }) =>
			Option.match(pathOf(entries, id), {
				onNone: () => Result.fail(EntryNotFound.make({ id })),
				onSome: (path) =>
					Result.succeed(
						modifyList(entries, path.slice(0, -1), (list) =>
							Array.filter(list, (entry) => entry.id !== id),
						),
					),
			}),
	})

export const apply = (
	entries: ReadonlyArray<Entry>,
	op: Op,
): Result.Result<ReadonlyArray<Entry>, EntryNotFound | InvalidOperation> =>
	Result.flatMap(validate(entries), (current) =>
		Result.flatMap(applyUnchecked(current, op), validate),
	)
