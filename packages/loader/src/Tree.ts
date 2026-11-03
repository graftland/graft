/**
 * Pure operations on a tree of entries. A group's children live in its
 * `config`, so a path alternates between list indices and `"config"`.
 */
import {
	Array as Arr,
	Data,
	Option,
	Predicate,
	Record,
	Result,
	Schema,
} from "effect"
import type { Entry } from "./Entry"

export type Path = ReadonlyArray<string | number>

export class EntryNotFound extends Schema.TaggedError<
	EntryNotFound,
	{ readonly brand: unique symbol }
>()("EntryNotFound", { id: Schema.String }) {
	override get message(): string {
		return `No entry with id "${this.id}"`
	}
}

/** Fields of an entry other than its id; `undefined` removes a field. */
export type Patch = {
	readonly [K in Exclude<keyof Entry, "id">]?: Entry[K] | undefined
}

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
				Arr.isArray(entry.config) ? (entry.config as ReadonlyArray<Entry>) : [],
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
	Arr.flatMap(entries, (entry) => [
		entry.id,
		...Option.match(childrenOf(entry), { onNone: () => [], onSome: ids }),
	])

/** Replaces the list at `path` (the root list for `[]`), keeping everything else. */
const modifyList = (
	entries: ReadonlyArray<Entry>,
	path: Path,
	f: (list: ReadonlyArray<Entry>) => ReadonlyArray<Entry>,
): ReadonlyArray<Entry> => {
	const [index, , ...rest] = path
	if (index === undefined) return f(entries)
	return Arr.map(entries, (entry, i) =>
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

const withoutUndefined = (entry: Record<string, unknown>) =>
	Record.filter(entry, (value) => !Predicate.isUndefined(value)) as Entry

export const apply = (
	entries: ReadonlyArray<Entry>,
	op: Op,
): Result.Result<ReadonlyArray<Entry>, EntryNotFound> =>
	Op.$match(op, {
		Create: ({ entry, parent, position }) => {
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
							Arr.insertAt(
								list,
								Option.getOrElse(position, () => list.length),
								entry,
							).pipe(Option.getOrElse(() => Arr.append(list, entry))),
						),
					),
			})
		},
		Update: ({ id, patch }) =>
			Option.match(pathOf(entries, id), {
				onNone: () => Result.fail(EntryNotFound.make({ id })),
				onSome: (path) =>
					Result.succeed(
						modifyList(entries, path.slice(0, -1), (list) =>
							Arr.map(list, (entry) =>
								entry.id === id
									? withoutUndefined({ ...entry, ...patch })
									: entry,
							),
						),
					),
			}),
		Remove: ({ id }) =>
			Option.match(pathOf(entries, id), {
				onNone: () => Result.fail(EntryNotFound.make({ id })),
				onSome: (path) =>
					Result.succeed(
						modifyList(entries, path.slice(0, -1), (list) =>
							Arr.filter(list, (entry) => entry.id !== id),
						),
					),
			}),
	})
