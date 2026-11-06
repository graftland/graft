/**
 * Entries describe which plugins to load and how, as plain data that a
 * config file can hold.
 */
import {
	Array,
	Config,
	Context,
	Data,
	Effect,
	MutableList,
	Option,
	Record,
	Result,
	Schema,
	SchemaGetter,
} from "effect"

import {
	assignIds,
	EntriesId,
	EntryDefinition,
	validateIds,
} from "./internal/entryIds"
import { isContainer } from "./internal/snapshot"

/** A value read from an environment variable when the entry is loaded (`!env NAME` in YAML). */
export class Env extends Data.TaggedClass("Env")<{ readonly name: string }> {}

/**
 * The id of the entry a plugin was loaded from. Ids persist in the config
 * file, including plugin entry lists. Outside a file, missing ids derive from
 * the parent id, plugin name and occurrence among anonymous same-name siblings.
 */
export const CurrentId = Context.Reference<Option.Option<string>>(
	"@graftland/loader/Entry/CurrentId",
	{ defaultValue: () => Option.none() },
)

/** The descriptions also document the config file's JSON Schema. */
const Fields = Schema.Struct({
	id: Schema.String.annotate({ description: "Identifies the entry." }),
	name: Schema.String.annotate({
		description:
			"The plugin's module: a relative path, a package name, or a short name. Ignored for groups.",
	}),
	config: Schema.optionalKey(Schema.Unknown).annotateKey({
		description: "The plugin's input. For a group, its list of entries.",
	}),
	disabled: Schema.optionalKey(
		Schema.Boolean.annotate({
			description: "true unloads the entry but keeps it in the file.",
		}),
	),
	group: Schema.optionalKey(
		Schema.Boolean.annotate({
			description: "true makes the entry a group of other entries.",
		}),
	),
	inject: Schema.optionalKey(
		Schema.Array(Schema.String).annotate({
			description:
				"Service keys to wait for before loading the plugin, in addition to its own inject.",
		}),
	),
	isolate: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Union([Schema.Literal(true), Schema.String]),
		).annotate({
			description:
				"Service or event keys to isolate: true for a private realm, or a label for a shared one.",
		}),
	),
	intercept: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Unknown).annotate({
			description:
				"Patches for registered references, applying to this entry and its descendants. Each value is resolved, decoded with the registered Schema, then merged.",
		}),
	),
})

/** Known fields are validated; additional entry metadata is preserved as unknown data. */
export const Entry = Schema.StructWithRest(Fields, [
	Schema.Record(Schema.String, Schema.Unknown),
])

export type Entry = typeof Entry.Type

/** An entry whose identity Graft may assign. Additional metadata is preserved. */
export const NewEntry = Schema.StructWithRest(
	Schema.Struct({ ...Fields.fields, id: Schema.optionalKey(Fields.fields.id) }),
	[Schema.Record(Schema.String, Schema.Unknown)],
)
export type NewEntry = typeof NewEntry.Type

/** Hosted entries with automatic identities and the config file's registered plugin schemas. */
export const Entries = Schema.Array(NewEntry)
	.check(
		Schema.makeFilter(
			(entries) => {
				const checked = validateIds(entries)
				return Result.isFailure(checked) ? checked.failure : undefined
			},
			{
				[EntriesId]: true,
				toJsonSchema: () => ({
					items: { $ref: `#/definitions/${EntryDefinition}` },
				}),
			},
		),
	)
	.pipe(
		Schema.decodeTo(Schema.Array(Entry), {
			decode: SchemaGetter.transformEffect((entries) =>
				Effect.map(CurrentId, (parent) => assignIds(entries, parent)),
			),
			encode: SchemaGetter.transform((entries) => entries),
		}),
	)

/** Selects entries for this loader subtree; excluded entries remain in the store. */
export const Select = Context.Reference<(entry: Entry) => boolean>(
	"@graftland/loader/Entry/Select",
	{ defaultValue: () => () => true },
)

export class CyclicConfig extends Schema.TaggedError<
	CyclicConfig,
	{ readonly brand: unique symbol }
>()("CyclicConfig", {
	path: Schema.Array(Schema.String),
}) {
	override get message(): string {
		return `Configuration contains a cycle at ${Array.join(this.path, ".") || "<root>"}`
	}
}

/** Identity-based graph traversal; sharing is allowed, but a back edge is not. */
export const checkAcyclic = (
	value: unknown,
): Result.Result<void, CyclicConfig> => {
	// These sets are local to one synchronous traversal. Structural equality
	// cannot distinguish a back edge from a distinct object with equal fields.
	const active = new WeakSet<object>()
	const finished = new WeakSet<object>()
	const work = MutableList.make<{
		readonly value: unknown
		readonly path: ReadonlyArray<string>
		readonly leave: boolean
	}>()
	MutableList.prepend(work, { value, path: [], leave: false })
	while (work.length > 0) {
		const frame = MutableList.take(work)
		if (frame === MutableList.Empty) break
		const { value, path, leave } = frame
		if (!isContainer(value)) continue
		if (leave) {
			active.delete(value)
			finished.add(value)
			continue
		}
		if (active.has(value)) return Result.fail(CyclicConfig.make({ path }))
		if (finished.has(value)) continue
		active.add(value)
		MutableList.prepend(work, { value, path, leave: true })
		for (const [key, child] of Record.toEntries(
			value as Record<string, unknown>,
		)) {
			MutableList.prepend(work, {
				value: child,
				path: [...path, key],
				leave: false,
			})
		}
	}
	return Result.succeed(undefined)
}

/** Rejects cycles and resolves Env while preserving sharing within each execution. */
export const resolveEnv = (
	value: unknown,
): Effect.Effect<unknown, Config.ConfigError | CyclicConfig> =>
	Effect.suspend(() => {
		// Identity, not structural equality: this cache belongs to one execution,
		// so rerunning the Effect reads the current configuration provider again.
		const resolved = new WeakMap<object, unknown>()
		const resolve = (
			value: unknown,
		): Effect.Effect<unknown, Config.ConfigError> =>
			Effect.suspend(() => {
				if (value instanceof Env) return Config.String(value.name)
				if (!isContainer(value)) return Effect.succeed(value)
				if (resolved.has(value)) return Effect.succeed(resolved.get(value))
				const result: Effect.Effect<unknown, Config.ConfigError> =
					Array.isArray(value)
						? Effect.forEach(value, resolve)
						: Effect.map(
								Effect.forEach(
									Record.toEntries(value as Record<string, unknown>),
									([key, inner]) =>
										Effect.map(
											resolve(inner),
											(value) => [key, value] as const,
										),
								),
								Record.fromEntries,
							)
				return Effect.map(result, (result) => {
					resolved.set(value, result)
					return result
				})
			})
		return Effect.andThen(
			Effect.fromResult(checkAcyclic(value)),
			resolve(value),
		)
	})
