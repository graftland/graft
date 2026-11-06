/** Prompt content and completions belong to the offering plugin. */
import { Context, Effect, Record, Schema, type Scope } from "effect"
import { McpServer, type McpSchema } from "effect/ai"

import type { Graft } from "@graftland/graft"

import * as Catalog from "./Catalog"

export interface Prompt<
	Params extends Schema.Struct.Fields,
	E,
	R,
	CE = never,
	CR = never,
> {
	readonly name: string
	readonly title?: string | undefined
	readonly description?: string | undefined
	readonly parameters?: Params | undefined
	readonly content: (
		params: Schema.Struct.Type<Params>,
	) => Effect.Effect<Array<McpSchema.PromptMessage> | string, E, R>
	readonly completion?:
		| {
				readonly [K in keyof Params]?: (
					input: string,
					context: Parameters<
						Parameters<
							McpServer.McpServer["Service"]["addPrompt"]
						>[0]["completions"][string]
					>[1],
				) => Effect.Effect<Array<Params[K]["Type"]>, CE, CR>
		  }
		| undefined
	readonly annotations?: Context.Context<never> | undefined
}

export type Registration = Prompt<
	Record<string, Schema.Codec<unknown, string>>,
	unknown,
	never,
	unknown,
	never
>
export const kind: Catalog.Kind<Registration> = {
	key: "@graftland/plugin-mcp-server/Prompts/kind",
	list: "prompts",
	identities: (item) => [item.name],
	completions: (item) => Record.keys(item.completion ?? {}),
	install: (item, annotations) =>
		McpServer.registerPrompt({
			...item,
			completion: item.completion as Record<
				string,
				(
					input: string,
					context: Parameters<
						Parameters<
							McpServer.McpServer["Service"]["addPrompt"]
						>[0]["completions"][string]
					>[1],
				) => Effect.Effect<Array<unknown>, unknown>
			>,
			annotations: Catalog.enabledWhen(annotations, item.annotations),
		}),
}

export const offer = <
	Params extends Schema.Struct.Fields = {},
	E = never,
	R = never,
	CE = never,
	CR = never,
>(
	item: Prompt<Params, E, R, CE, CR>,
): Effect.Effect<
	void,
	never,
	| Graft.Graft
	| Scope.Scope
	| Exclude<
			| R
			| CR
			| Params[keyof Params]["DecodingServices"]
			| Params[keyof Params]["EncodingServices"],
			Catalog.RequestServices
	  >
> =>
	Effect.gen(function* () {
		const services =
			yield* Effect.context<
				Exclude<
					| R
					| CR
					| Params[keyof Params]["DecodingServices"]
					| Params[keyof Params]["EncodingServices"],
					Catalog.RequestServices
				>
			>()
		const content = yield* Catalog.own(item.content)
		const completion = yield* Effect.forEach(
			Record.toEntries(item.completion ?? {}),
			([key, handler]) =>
				Effect.map(Catalog.own(handler!), (owned) => [key, owned] as const),
		)
		const registration = {
			...item,
			content,
			completion: Record.fromEntries(completion),
		} as unknown as Registration
		yield* Catalog.offer(
			{
				...kind,
				install: (item, annotations) =>
					// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the kind erases errors; the projection records and logs its full exit
					kind.install(item, annotations).pipe(Effect.provide(services)),
			},
			registration,
		)
	})
