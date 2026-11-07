/** Resources use Effect's public registration objects. */
import { Array, Context, Effect, Record, Schema, type Scope } from "effect"
import { McpSchema, McpServer } from "effect/ai"

import { Event, type Graft } from "@graftland/graft"

import * as Catalog from "./Catalog"

export interface Resource<E = never, R = never> {
	readonly uri: string
	readonly name: string
	readonly description?: string | undefined
	readonly mimeType?: string | undefined
	readonly audience?: ReadonlyArray<"user" | "assistant"> | undefined
	readonly priority?: number | undefined
	readonly content: Effect.Effect<
		McpSchema.ReadResourceResult | string | Uint8Array,
		E,
		R
	>
	readonly annotations?: Context.Context<never> | undefined
}

export const kind: Catalog.Kind<Resource<unknown>> = {
	key: "@graftland/plugin-mcp-server/Resources/kind",
	list: "resources",
	identities: (item) => [item.uri],
	install: (item, annotations) =>
		McpServer.registerResource({
			...item,
			annotations: Catalog.enabledWhen(annotations, item.annotations),
		}),
}

/** A prepared public template registration, with plugin-owned content and completions. */
export interface Template {
	readonly uriTemplate: string
	readonly annotations?: Context.Context<never> | undefined
	readonly completionKeys: ReadonlyArray<string>
	readonly register: (
		annotations: Context.Context<never>,
	) => Effect.Effect<void, never, McpServer.McpServer>
}

/** Uses Effect's public tagged-template form; Effect compiles and decodes the route. */
export const template =
	<const Schemas extends ReadonlyArray<Schema.Constraint>>(
		segments: TemplateStringsArray,
		...schemas: Schemas
	) =>
	<E, R, CE = never, CR = never>(options: {
		readonly name: string
		readonly description?: string | undefined
		readonly mimeType?: string | undefined
		readonly audience?: ReadonlyArray<"user" | "assistant"> | undefined
		readonly priority?: number | undefined
		readonly annotations?: Context.Context<never> | undefined
		readonly content: (
			uri: string,
			...params: { readonly [K in keyof Schemas]: Schemas[K]["Type"] }
		) => Effect.Effect<McpSchema.ReadResourceResult | string | Uint8Array, E, R>
		readonly completion?:
			| {
					readonly [K in keyof McpServer.ResourceCompletions<Schemas>]?: (
						input: string,
						context: Parameters<
							Parameters<
								McpServer.McpServer["Service"]["addResourceTemplate"]
							>[0]["completions"][string]
						>[1],
					) => Effect.Effect<
						McpServer.ResourceCompletions<Schemas>[K] extends (
							...args: never[]
						) => Effect.Effect<infer A, any, any>
							? A
							: never,
						CE,
						CR
					>
			  }
			| undefined
	}): Effect.Effect<
		Template,
		never,
		| Scope.Scope
		| Exclude<
				| R
				| CR
				| Schemas[number]["DecodingServices"]
				| Schemas[number]["EncodingServices"],
				Catalog.RequestServices
		  >
	> =>
		Effect.gen(function* () {
			const services =
				yield* Effect.context<
					Exclude<
						| R
						| CR
						| Schemas[number]["DecodingServices"]
						| Schemas[number]["EncodingServices"],
						Catalog.RequestServices
					>
				>()
			const content = yield* Catalog.own(options.content)
			const completion = yield* Effect.forEach(
				Record.toEntries(
					(options.completion as Record<string, never>) ?? {},
				) as Array<
					[
						string,
						(
							input: string,
							context: Parameters<
								Parameters<
									McpServer.McpServer["Service"]["addResourceTemplate"]
								>[0]["completions"][string]
							>[1],
						) => Effect.Effect<Array<unknown>, CE, CR>,
					]
				>,
				([key, handler]) =>
					Effect.map(Catalog.own(handler!), (owned) => [key, owned] as const),
			)
			// Param names and paramN are the public ResourceCompletions naming convention.
			const uriTemplate = Array.reduce(
				schemas,
				segments[0]!,
				(uri, schema, index) =>
					uri +
					"{" +
					(McpSchema.isParam(schema) ? schema.name : "param" + index) +
					"}" +
					segments[index + 1],
			)
			return {
				uriTemplate,
				annotations: options.annotations,
				completionKeys: Array.map(completion, ([key]) => key),
				register: (annotations) =>
					McpServer.registerResource(
						segments,
						...(schemas as unknown as ReadonlyArray<
							Schema.Codec<unknown, unknown>
						>),
					)({
						...options,
						content: content as (
							uri: string,
							...params: ReadonlyArray<unknown>
						) => Effect.Effect<
							McpSchema.ReadResourceResult | string | Uint8Array,
							E
						>,
						completion: Record.fromEntries(completion) as {},
						annotations,
					}).pipe(Effect.provide(services)),
			}
		})

export const templateKind: Catalog.Kind<Template> = {
	key: "@graftland/plugin-mcp-server/Resources/templateKind",
	list: "resourceTemplates",
	identities: (item) => [item.uriTemplate],
	completions: (item) => item.completionKeys,
	install: (item, annotations) =>
		item.register(Catalog.enabledWhen(annotations, item.annotations)),
}

export function offer<E, R>(
	item: Resource<E, R>,
): Effect.Effect<
	void,
	never,
	Graft.Graft | Scope.Scope | Exclude<R, Catalog.RequestServices>
>
export function offer(
	item: Template,
): Effect.Effect<void, never, Graft.Graft | Scope.Scope>
export function offer(item: Resource<unknown, unknown> | Template) {
	return Effect.gen(function* () {
		if ("register" in item) {
			yield* Catalog.offer(templateKind, item)
		} else {
			// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- overload implementation erases the resource error and requirements
			const content = yield* Catalog.own(() => item.content)
			// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the owned resource error is handled by Effect registerResource
			yield* Catalog.offer(kind, { ...item, content: content() })
		}
	})
}

export const Updated = Event.make<[uri: string]>(
	"@graftland/plugin-mcp-server/Resources/Updated",
)
export const updated = (uri: string) => Event.emit(Updated, uri)
