/** Toolkit contributions with plugin-owned handlers. */
import { Array, Context, Effect, Record, Scope } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"

import { Plugin, type Graft as GraftModule } from "@graftland/graft"

import * as Catalog from "./Catalog"
import type { RequestServices } from "./internal/own"

export interface Registration {
	readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>
	readonly handlers: Context.Context<Tool.HandlersFor<Record<string, Tool.Any>>>
}

export const kind: Catalog.Kind<Registration> = {
	key: "@graftland/plugin-mcp-server/Tools/kind",
	list: "tools",
	identities: (item) =>
		Array.map(Record.values(item.toolkit.tools), (tool) => tool.name),
	install: (item, annotations) =>
		// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the existential toolkit's handlers are supplied by the offer
		McpServer.registerToolkit(
			Toolkit.make(
				...Array.map(Record.values(item.toolkit.tools), (tool) =>
					tool.annotateMerge(
						Catalog.enabledWhen(annotations, tool.annotations),
					),
				),
			),
		).pipe(Effect.provide(item.handlers)),
}

export type Services<Tools extends Record<string, Tool.Any>> = Exclude<
	Tool.HandlerServices<Tools[keyof Tools]>,
	RequestServices
>

type AnyHandler = (
	...args: ReadonlyArray<unknown>
) => Effect.Effect<unknown, unknown>

export const offer = <Tools extends Record<string, Tool.Any>>(
	toolkit: Toolkit.Toolkit<Tools>,
	handlers: Toolkit.HandlersFrom<Tools>,
): Effect.Effect<
	void,
	never,
	GraftModule.Graft | Scope.Scope | Services<Tools>
> =>
	Effect.gen(function* () {
		const services = yield* Effect.context<Services<Tools>>()
		const owned = yield* Effect.forEach(
			Record.toEntries(handlers as Readonly<Record<string, AnyHandler>>),
			([key, handler]) =>
				Effect.map(Catalog.own(handler), (owned) => [key, owned] as const),
		)
		const context = yield* toolkit.toHandlers(
			Record.fromEntries(owned) as unknown as Toolkit.HandlersFrom<Tools>,
		)
		yield* Catalog.offer(kind, {
			toolkit: toolkit as unknown as Registration["toolkit"],
			handlers: Context.merge(services, context) as Registration["handlers"],
		})
	})

/** Services the tools need that `inject` does not list. */
export type Undeclared<
	Tools extends Record<string, Tool.Any>,
	Inject extends ReadonlyArray<Plugin.Dependency>,
> = Exclude<Services<Tools>, Plugin.Required<Inject>>

/**
 * A plugin that serves a toolkit while it is loaded. `handlers` builds the
 * handlers and may use the services in `inject`; so may the tools, through
 * their `dependencies` and schemas.
 */
export const plugin = <
	Tools extends Record<string, Tool.Any>,
	const Inject extends ReadonlyArray<Plugin.Dependency> = [],
	E = never,
>(
	options: {
		readonly name: string
		readonly toolkit: Toolkit.Toolkit<Tools>
		readonly inject?: Inject
		readonly handlers: Effect.Effect<
			Toolkit.HandlersFrom<Tools>,
			E,
			Plugin.Requirements<Inject>
		>
	} & ([Undeclared<Tools, Inject>] extends [never]
		? unknown
		: { readonly "List these services in inject": Undeclared<Tools, Inject> }),
) =>
	Plugin.make({
		name: options.name,
		inject: options.inject ?? ([] as unknown as Inject),
		apply: () =>
			Effect.flatMap(
				options.handlers,
				(handlers) =>
					// Undeclared is empty here, so the tools' services come from inject.
					offer(options.toolkit, handlers) as Effect.Effect<
						void,
						never,
						Plugin.Requirements<Inject>
					>,
			),
	})
