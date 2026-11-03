/**
 * The JSON Schema of the config file that graft start reads, derived from the
 * loader's entry fields and the intercepts the CLI registers. The build writes
 * it to the package's schema.json, so each release ships its own version.
 */
import { Entry } from "@graftland/loader"
import { Array, JsonSchema, Record, Schema } from "effect"
import { registrations } from "./intercepts"

const fields = Entry.Entry.schema.fields

const Intercept = Schema.Struct(
	Record.fromEntries(
		Array.map(
			registrations,
			({ key, schema }) => [key, Schema.optionalKey(schema)] as const,
		),
	),
).annotate({
	identifier: "Intercept",
	description:
		"Patches for references, applying to this entry and its descendants.",
})

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

/** Draft-07, which YAML language servers support most widely. */
export const make = () => {
	const document = JsonSchema.toDocumentDraft07(
		// Only the intercept struct is closed: entries keep a rest record for metadata.
		Schema.toJsonSchemaDocument(File, { onExcessProperty: "error" }),
	)
	return {
		$schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
		...document.schema,
		definitions: document.definitions,
	}
}
