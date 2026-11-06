import { Effect, Schema } from "effect"

/** Paths served by documentation plugins. */
export const Path = Schema.TemplateLiteral(["/", Schema.String])
/** Shared configuration for a documentation UI. */
export const UiConfig = Schema.Struct({
	path: Path.annotate({
		description: "Documentation route.",
		default: "/docs",
	}).pipe(Schema.withDecodingDefaultKey(Effect.succeed("/docs"))),
})
/** Configuration of the optional document composer. */
export const Config = Schema.Struct({
	title: Schema.optionalKey(
		Schema.String.annotate({ description: "OpenAPI title." }),
	),
	version: Schema.optionalKey(
		Schema.String.annotate({ description: "OpenAPI version." }),
	),
	description: Schema.optionalKey(
		Schema.String.annotate({ description: "OpenAPI description." }),
	),
	servers: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				url: Schema.String.annotate({ description: "Server URL." }),
				description: Schema.optionalKey(
					Schema.String.annotate({ description: "Server description." }),
				),
			}),
		).annotate({ description: "OpenAPI servers." }),
	),
	openapi: Schema.Union([Path, Schema.Literal(false)])
		.annotate({
			description: "OpenAPI route, or false to disable.",
			default: "/openapi.json",
		})
		.pipe(Schema.withDecodingDefaultKey(Effect.succeed("/openapi.json"))),
})
export type Config = typeof Config.Type
