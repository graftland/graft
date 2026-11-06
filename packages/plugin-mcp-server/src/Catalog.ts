/** Plugin-owned offers; helpers only register events and never start a server. */
import { Context, Effect, Schema } from "effect"
import { McpSchema, McpServer } from "effect/ai"

import { Event } from "@graftland/graft"

export { own, type RequestServices } from "./internal/own"

export interface Kind<Item> {
	readonly key: string
	readonly list: "tools" | "resources" | "resourceTemplates" | "prompts"
	readonly identities: (item: Item) => ReadonlyArray<string>
	/** Completion argument names owned by this registration. */
	readonly completions?: (item: Item) => ReadonlyArray<string>
	readonly install: (
		item: Item,
		annotations: Context.Context<never>,
	) => Effect.Effect<void, unknown, McpServer.McpServer>
}

/** An existential package: only its kind interprets its item. */
export interface Offer {
	readonly kind: Kind<any>
	readonly item: unknown
}

export const Offered = Event.make<[], ReadonlyArray<Offer>>(
	"@graftland/plugin-mcp-server/Catalog/Offered",
)
export const Changed = Event.make<[]>(
	"@graftland/plugin-mcp-server/Catalog/Changed",
)

export class Conflict extends Schema.TaggedError<
	Conflict,
	{ readonly brand: unique symbol }
>()("Conflict", {
	list: Schema.String,
	identities: Schema.Array(Schema.String),
}) {}

export const advertise = (offer: Offer) =>
	Effect.gen(function* () {
		yield* Effect.addFinalizer(() => Event.emit(Changed))
		yield* Event.on(Offered, () => Effect.succeed([offer]))
		yield* Event.emit(Changed)
	})

export const offer = <Item>(kind: Kind<Item>, item: Item) =>
	advertise({ kind, item })

/** AND the projection's liveness with the item's own per-request predicate. */
export const enabledWhen = (
	annotations: Context.Context<never>,
	own: Context.Context<never> = Context.empty(),
): Context.Context<never> => {
	const live = Context.getOrUndefined(annotations, McpSchema.EnabledWhen)
	const enabled = Context.getOrUndefined(own, McpSchema.EnabledWhen)
	return Context.add(
		Context.merge(own, annotations),
		McpSchema.EnabledWhen,
		(profile) => (live?.(profile) ?? true) && (enabled?.(profile) ?? true),
	)
}
