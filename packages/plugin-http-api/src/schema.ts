import { Array, JsonSchema, Schema } from "effect"

import { Config, UiConfig } from "./Config"

/** Editor registrations for the composer and independently loadable UIs. */
export const entries = () =>
	Array.map(
		[
			{ names: ["@graftland/plugin-http-api", "http-api"], schema: Config },
			{
				names: ["@graftland/plugin-http-api/scalar", "http-api/scalar"],
				schema: UiConfig,
			},
			{
				names: ["@graftland/plugin-http-api/swagger", "http-api/swagger"],
				schema: UiConfig,
			},
		],
		({ names, schema }) => ({
			names,
			required: false,
			schema: JsonSchema.toDocumentDraft07(
				Schema.toJsonSchemaDocument(schema, {
					referencePolicy: () => undefined,
					onExcessProperty: "error",
				}),
			).schema,
		}),
	)
