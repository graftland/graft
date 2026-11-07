/** Public group contributions and document snapshots, independent of the composer. */
import {
	Array,
	Context,
	Effect,
	Layer,
	Schema,
	type SubscriptionRef,
} from "effect"
import { HttpServer } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	type HttpApiGroup,
	type OpenApi,
} from "effect/http-api"

import { Event } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

/** Ask every plugin which groups it serves. */
export const Groups = Event.make<[], ReadonlyArray<HttpApiGroup.Constraint>>(
	"@graftland/plugin-http-api/HttpApis/Groups",
)
/** Signal that the answers to Groups changed. Observers should only enqueue work. */
export const GroupsChanged = Event.make<[]>(
	"@graftland/plugin-http-api/HttpApis/GroupsChanged",
)
/** Groups excluded from a document; their serving lifetime is unaffected. */
export class GroupConflict extends Schema.TaggedError<
	GroupConflict,
	{ readonly brand: unique symbol }
>()("GroupConflict", {
	groups: Schema.Array(Schema.String),
	reason: Schema.optionalKey(Schema.String),
	cause: Schema.optionalKey(Schema.Defect()),
}) {
	override get message(): string {
		return `The groups ${Array.join(this.groups, ", ")} cannot be documented together; none of them is documented${this.reason !== undefined ? ` (${this.reason})` : ""}`
	}
}
/** A complete composition could not be generated; retain the previous document. */
export class CompositionError extends Schema.TaggedError<
	CompositionError,
	{ readonly brand: unique symbol }
>()("CompositionError", { cause: Schema.Defect() }) {}
/** A coherent API and its successfully generated OpenAPI document. */
export interface Snapshot {
	readonly api: HttpApi.Top
	readonly spec: OpenApi.OpenAPISpec
}
/** The composer's live document. UI plugins inject this key. */
export class Document extends Context.Service<
	Document,
	SubscriptionRef.SubscriptionRef<Snapshot>
>()("@graftland/plugin-http-api/HttpApis/Document") {}
/** Group annotation linking a contract to the exact mount that serves it. */
export class ServingMount extends Context.Service<ServingMount, Http.Mount>()(
	"@graftland/plugin-http-api/HttpApis/ServingMount",
) {}
/** Answer Groups until this scope closes. Supply the mount for served-state filtering. */
export const advertise = Effect.fn("HttpApis.advertise")(function* (
	groups: ReadonlyArray<HttpApiGroup.Constraint>,
	mount?: Http.Mount,
) {
	const concrete = groups as ReadonlyArray<HttpApiGroup.Top>
	const advertised =
		mount === undefined
			? concrete
			: Array.map(concrete, (group) => group.annotate(ServingMount, mount))
	yield* Effect.addFinalizer(() => Event.emit(GroupsChanged))
	yield* Event.on(Groups, () => Effect.succeed(advertised))
	yield* Event.emit(GroupsChanged)
})
/** Serve selected groups with ordinary HttpApiBuilder handlers and advertise their contracts. */
export const serve = <
	Id extends string,
	G extends HttpApiGroup.Constraint,
	const Selected extends Array.NonEmptyReadonlyArray<
		HttpApiGroup.Identifier<G>
	>,
	E,
	R,
>(
	api: HttpApi.HttpApi<Id, G>,
	groups: Selected,
	handlers: Layer.Layer<
		HttpApiGroup.ToService<
			Id,
			HttpApiGroup.WithIdentifier<G, Selected[number]>
		>,
		E,
		R
	>,
) =>
	Effect.gen(function* () {
		// The selected identifiers preserve the group union, which TypeScript cannot reduce through GroupMap.
		const selected = Array.map(
			groups,
			(id: Selected[number]) => api.groups[id],
		) as Array.NonEmptyReadonlyArray<
			HttpApiGroup.WithIdentifier<G, Selected[number]>
		>
		const sub = HttpApi.make(api.identifier).add(...selected)
		const mounted = yield* Http.mount(
			HttpApiBuilder.layer(sub).pipe(
				Layer.provide(HttpServer.layerServices),
				Layer.provide(handlers),
			),
		)
		yield* advertise(selected, Context.get(mounted, Http.Mounted))
	})
