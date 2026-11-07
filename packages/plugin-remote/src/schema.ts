/** Editor registrations of the remote entries, for composing the JSON Schema of graft.yml. */
import { JsonSchema, Schema } from "effect"

import { Cli, Host, Runner } from "./Config"

/** With inline schemas so consumers can compose them without reference collisions. */
export const entries = () => [
	{
		names: ["remote", "@graftland/plugin-remote"],
		schema: json(Host),
		required: true,
	},
	{
		names: ["remote/runner", "@graftland/plugin-remote/runner"],
		schema: json(Runner),
		required: true,
	},
	{ names: ["remote/cli", "@graftland/plugin-remote/cli"], schema: json(Cli) },
]
const json = (schema: Schema.Top) =>
	JsonSchema.toDocumentDraft07(
		Schema.toJsonSchemaDocument(schema, {
			referencePolicy: () => undefined,
			onExcessProperty: "error",
		}),
	).schema
