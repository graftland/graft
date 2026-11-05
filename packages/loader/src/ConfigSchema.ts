/** Compose the editor schema for a config file without loading plugin implementations. */
import { Array, JsonSchema, Schema } from "effect"

import * as Entry from "./Entry"

/** A plugin name and its aliases share one encoded JSON Schema for config. */
export interface Registration {
	readonly names: ReadonlyArray<string>
	readonly schema: JsonSchema.JsonSchema
	readonly required?: boolean
}
/** Explicit editor extensions; unknown plugins and entry metadata stay open. */
export interface Options {
	readonly entries?: ReadonlyArray<Registration>
	readonly intercept?: Schema.Top
}
/** Draft-07, which YAML language servers support most widely. */
export const make = (options: Options = {}) => {
	const fields = Entry.Entry.schema.fields
	const Intercept =
		options.intercept ?? Schema.Record(Schema.String, Schema.Unknown)
	const Metadata = [Schema.Record(Schema.String, Schema.Unknown)] as const

	const shared = {
		...fields,
		id: Schema.optionalKey(
			fields.id.annotate({
				description:
					"Identifies the entry. Graft adds one, and writes it to the file, if an entry has none.",
			}),
		),
		intercept: Schema.optionalKey(Intercept),
	}

	// Two shapes instead of one, so that only a group's config is checked as a
	// list of entries; a plugin's config is checked by the plugin's own Schema.
	const FileEntry: Schema.Top = Schema.Union([
		Schema.StructWithRest(
			Schema.Struct({
				...shared,
				group: Schema.Literal(true).annotate({
					description: "true makes the entry a group of other entries.",
				}),
				config: Schema.optionalKey(
					Schema.Array(Schema.suspend(() => FileEntry)).annotate({
						description: "The entries of this group.",
					}),
				),
			}),
			Metadata,
		),
		Schema.StructWithRest(
			Schema.Struct({
				...shared,
				group: Schema.optionalKey(
					Schema.Literal(false).annotate({
						description: "true makes the entry a group of other entries.",
					}),
				),
			}),
			Metadata,
		),
	]).annotate({ identifier: "Entry" })

	const File = Schema.NullOr(Schema.Array(FileEntry)).annotate({
		title: "Graft config file",
		description:
			"The entries that graft start loads. Each entry loads one plugin, or groups other entries.",
	})

	const document = JsonSchema.toDocumentDraft07(
		// Only the intercept struct is closed: entries keep a rest record for metadata.
		Schema.toJsonSchemaDocument(File, { onExcessProperty: "error" }),
	)
	return {
		$schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
		...document.schema,
		definitions: {
			...document.definitions,
			Entry: {
				...document.definitions["Entry"],
				...(options.entries === undefined || options.entries.length === 0
					? {}
					: {
							allOf: Array.map(
								options.entries,
								({ names, schema, required }) => ({
									if: {
										properties: {
											name: { enum: names },
											group: { const: false },
										},
										required: ["name"],
									},
									then: {
										properties: { config: schema },
										...(required === true ? { required: ["config"] } : {}),
									},
								}),
							),
						}),
			},
		},
	}
}
