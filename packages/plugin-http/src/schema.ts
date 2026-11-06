/** Editor registrations for the HTTP sibling entries. */
import { JsonSchema, Schema } from "effect"

import { Config, JwtConfig, OAuthConfig } from "./Config"

export const entries = () => [
	{
		required: true,
		names: ["@graftland/plugin-http", "http"],
		schema: document(Config),
	},
	{
		required: false,
		names: ["@graftland/plugin-http/router", "http/router"],
		schema: document(Schema.Struct({})),
	},
	{
		required: true,
		names: ["@graftland/plugin-http/oauth", "http/oauth"],
		schema: document(OAuthConfig),
	},
	{
		required: true,
		names: ["@graftland/plugin-http/oauth/jwt", "http/oauth/jwt"],
		schema: document(JwtConfig),
	},
]
const document = (schema: Schema.Top) =>
	JsonSchema.toDocumentDraft07(
		Schema.toJsonSchemaDocument(schema, {
			referencePolicy: () => undefined,
			onExcessProperty: "error",
		}),
	).schema
