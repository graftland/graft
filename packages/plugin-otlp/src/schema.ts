/** Editor registrations for every public plugin entry. */
import { Array, JsonSchema, Schema } from "effect"

import { Config, Http } from "./Config"

export const entries = () =>
	Array.map(
		[
			{ names: ["otlp", "@graftland/plugin-otlp"], config: Config },
			{ names: ["otlp/http", "@graftland/plugin-otlp/http"], config: Http },
		],
		({ names, config }) => ({
			names,
			schema: JsonSchema.toDocumentDraft07(
				Schema.toJsonSchemaDocument(config, {
					referencePolicy: () => undefined,
					onExcessProperty: "error",
				}),
			).schema,
			required: true,
		}),
	)
