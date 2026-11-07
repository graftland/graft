import { Effect, Schema } from "effect"
import { McpSchema } from "effect/ai"

export const ProtocolVersion = Schema.Literals([
	"2026-07-28",
	"2025-11-25",
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
])
const CacheHint = Schema.Struct({
	ttl: Schema.Union([Schema.Finite, Schema.FiniteFromString]).check(
		Schema.isGreaterThanOrEqualTo(0),
	),
	cacheScope: Schema.Literal("private").pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("private" as const)),
	),
})
export const Config = Schema.Struct({
	name: Schema.String.pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("graft")),
	),
	version: Schema.String.pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("0.0.0")),
	),
	description: Schema.optionalKey(Schema.String),
	websiteUrl: Schema.optionalKey(Schema.String),
	icons: Schema.optionalKey(Schema.Array(McpSchema.Icon)),
	instructions: Schema.optionalKey(Schema.String),
	protocols: Schema.NonEmptyArray(ProtocolVersion).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(ProtocolVersion.literals)),
	),
	cache: Schema.optionalKey(
		Schema.Struct({
			discover: Schema.optionalKey(CacheHint),
			tools: Schema.optionalKey(CacheHint),
			resources: Schema.optionalKey(CacheHint),
			resourceTemplates: Schema.optionalKey(CacheHint),
			prompts: Schema.optionalKey(CacheHint),
		}),
	),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})))
export type Config = typeof Config.Type
export const StdioConfig = Schema.Struct({}).pipe(
	Schema.withDecodingDefault(Effect.succeed({})),
)
export type StdioConfig = typeof StdioConfig.Type

/** Streamable HTTP routes on the shared router. */
export const HttpConfig = Schema.Struct({
	path: Schema.TemplateLiteral(["/", Schema.String]).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("/mcp" as const)),
	),
	allowedOrigins: Schema.optionalKey(Schema.Array(Schema.String)),
	authorization: Schema.optionalKey(
		Schema.Struct({
			// RFC 6749 section 3.3 (used by RFC 6750); matches plugin-http/Authorization.ScopeToken without loading the optional HTTP peer.
			scopes: Schema.Array(
				Schema.String.check(Schema.isPattern(/^[\x21\x23-\x5b\x5d-\x7e]+$/u)),
			),
		}),
	),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})))
