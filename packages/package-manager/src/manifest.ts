import { Array, Effect, HashMap, Option, Record, Schema, String } from "effect"

export const PackageName = Schema.String.check(
	Schema.isPattern(
		/^(?!(?:node_modules|favicon\.ico)$)(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i,
	),
	Schema.isMaxLength(214),
	Schema.isTrimmed(),
)
const isPackageName = Schema.is(PackageName)
// A refined Record key filters unmatched keys. Validate names after retaining
// every key so invalid input cannot silently become a partial change set.
const dependencyNames = Schema.makeFilter(
	(record: Readonly<Record<string, unknown>>) =>
		Array.map(
			Array.filter(Record.keys(record), (name) => !isPackageName(name)),
			(name) => ({
				path: [name],
				issue: "Invalid dependency name",
			}),
		),
)
const Dependencies = Schema.Record(Schema.String, Schema.String).check(
	dependencyNames,
)
export const Manifest = Schema.StructWithRest(
	Schema.Struct({
		packageManager: Schema.optionalKey(Schema.String),
		dependencies: Schema.optionalKey(Dependencies),
		devDependencies: Schema.optionalKey(Dependencies),
		optionalDependencies: Schema.optionalKey(Dependencies),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
)
export type Manifest = typeof Manifest.Type
const decodeJsonManifest = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Manifest),
)
// A BOM is a source-format marker, not part of the JSON value.
export const decodeManifest = (source: string) =>
	decodeJsonManifest(String.replace(/^\uFEFF/, "")(source))

export const Changes = Schema.Record(
	Schema.String,
	Schema.Union([Schema.String.check(Schema.isPattern(/\S/)), Schema.Null]),
).check(dependencyNames)
/** A spec adds or updates a dependency; null removes it from all dependency fields. */
export type Changes = typeof Changes.Type
export const fields = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
] as const

export const applyChanges = (
	manifest: Manifest,
	changes: Changes,
): Manifest => {
	let next = manifest
	for (const [name, spec] of Record.toEntries(changes)) {
		const existing = Array.filter(fields, (field) =>
			Record.has(next[field] ?? {}, name),
		)
		const targets =
			spec === null || existing.length > 0
				? existing
				: (["dependencies"] as const)
		for (const field of targets) {
			const deps = next[field] ?? {}
			next = {
				...next,
				[field]:
					spec === null
						? Record.remove(deps, name)
						: Record.set(deps, name, spec),
			}
		}
	}
	return next
}

const decodeKey = Schema.decodeEffect(Schema.fromJsonString(Schema.String))
const encodeString = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

interface Member {
	readonly name: string
	readonly leading: string
	readonly key: string
	readonly colon: string
	readonly value: string
	readonly trailing: string
}

/** Read member spans from a JSON object already validated by decodeManifest. */
const readObject = Effect.fnUntraced(function* (source: string) {
	// Strings are single tokens, so punctuation inside them cannot affect nesting.
	const tokens = Array.fromIterable(
		String.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)(
			source,
		),
	)
	let members: ReadonlyArray<Member> = []
	let cursor = 1
	let start = (tokens[0]?.index ?? 0) + 1
	while (cursor < tokens.length && tokens[cursor]?.[0] !== "}") {
		const key = tokens[cursor]!
		const valueStart = tokens[cursor + 2]!.index
		cursor += 2
		let depth = 0
		let end = valueStart
		do {
			const token = tokens[cursor++]!
			if (token[0] === "{" || token[0] === "[") depth++
			if (token[0] === "}" || token[0] === "]") depth--
			end = token.index! + token[0].length
		} while (depth > 0)
		members = Array.append(members, {
			name: yield* decodeKey(key[0]),
			leading: String.slice(start, key.index)(source),
			key: key[0],
			colon: String.slice(key.index! + key[0].length, valueStart)(source),
			value: String.slice(valueStart, end)(source),
			trailing:
				tokens[cursor]?.[0] === ","
					? String.slice(end, tokens[cursor]!.index)(source)
					: "",
		})
		start = end
		if (tokens[cursor]?.[0] !== ",") break
		start = tokens[cursor++]!.index! + 1
	}
	const close = tokens[cursor]!.index
	const tail = String.slice(start, close)(source)
	return { members, tail, open: tokens[0]!.index!, close }
})

/** Ordered edits preserve insertion order; None removes every occurrence. */
type Edits = ReadonlyArray<readonly [string, Option.Option<string>]>

const editObject = Effect.fnUntraced(function* (
	source: string,
	changes: Edits,
) {
	const { members, tail, open, close } = yield* readObject(source)
	const edits = HashMap.fromIterable(changes)
	const first = Array.head(members)
	const lastOccurrences = HashMap.fromIterable(
		Array.map(members, (member, index) => [member.name, index] as const),
	)
	const retained = Array.flatMap(members, (member, index) =>
		Option.match(HashMap.get(edits, member.name), {
			onNone: () => [member],
			onSome: (change) =>
				Option.match(change, {
					// Removing every occurrence prevents an earlier value from becoming active.
					onNone: () => [],
					onSome: (value) => [
						Option.getOrUndefined(HashMap.get(lastOccurrences, member.name)) ===
						index
							? { ...member, value }
							: member,
					],
				}),
		}),
	)
	const added = yield* Effect.forEach(
		Array.filter(changes, ([name]) => !HashMap.has(lastOccurrences, name)),
		Effect.fnUntraced(function* ([name, change]) {
			if (Option.isNone(change)) return []
			const key = yield* encodeString(name)
			return [
				{
					name,
					leading: Option.match(first, {
						onNone: () => tail,
						onSome: (member) => member.leading,
					}),
					key,
					colon: Option.match(first, {
						onNone: () => ": ",
						onSome: (member) => member.colon,
					}),
					value: change.value,
					trailing: "",
				},
			]
		}),
	)
	return (
		String.slice(0, open + 1)(source) +
		Array.join(
			Array.map(
				[...retained, ...Array.flatten(added)],
				(member) =>
					member.leading +
					member.key +
					member.colon +
					member.value +
					member.trailing,
			),
			",",
		) +
		tail +
		String.slice(close)(source)
	)
})

export const encodeManifest = Effect.fnUntraced(function* (
	manifest: Manifest,
	original: string,
) {
	const before = yield* decodeManifest(original)
	const { members } = yield* readObject(original)
	const changes = yield* Effect.reduce(
		fields,
		(): Edits => [],
		Effect.fnUntraced(function* (changes, field) {
			const oldSpecs = HashMap.fromIterable(
				Record.toEntries(before[field] ?? {}),
			)
			const nextSpecs = HashMap.fromIterable(
				Record.toEntries(manifest[field] ?? {}),
			)
			const specs = yield* Effect.reduce(
				Array.dedupe([
					...Record.keys(before[field] ?? {}),
					...Record.keys(manifest[field] ?? {}),
				]),
				(): Edits => [],
				Effect.fnUntraced(function* (specs, name) {
					const old = HashMap.get(oldSpecs, name)
					const next = HashMap.get(nextSpecs, name)
					if (Option.getOrUndefined(old) === Option.getOrUndefined(next))
						return specs
					const value = yield* Option.match(next, {
						onNone: () => Effect.succeedNone,
						onSome: (value) => encodeString(value).pipe(Effect.asSome),
					})
					return Array.append(specs, [name, value] as const)
				}),
			)
			if (specs.length === 0) return changes
			const section = Array.findLast(members, (member) => member.name === field)
			const source = Option.match(section, {
				onNone: () => "{}",
				onSome: (member) => member.value,
			})
			const edited = yield* editObject(source, specs)
			return Array.append(changes, [field, Option.some(edited)] as const)
		}),
	)
	return changes.length === 0 ? original : yield* editObject(original, changes)
})
