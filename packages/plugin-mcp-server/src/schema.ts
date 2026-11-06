import { JsonSchema, Schema } from "effect"

import { Config, HttpConfig, StdioConfig } from "./Config"

export const entries = () => [
	{
		names: ["mcp-server", "@graftland/plugin-mcp-server"],
		schema: document(Config),
	},
	{
		names: ["mcp-server/stdio", "@graftland/plugin-mcp-server/stdio"],
		schema: document(StdioConfig),
	},
	{
		names: ["mcp-server/http", "@graftland/plugin-mcp-server/http"],
		schema: document(HttpConfig),
	},
]
const document = (schema: Schema.Top) =>
	JsonSchema.toDocumentDraft07(
		Schema.toJsonSchemaDocument(schema, {
			referencePolicy: () => undefined,
			onExcessProperty: "error",
		}),
	).schema
