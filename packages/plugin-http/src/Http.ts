/** Public route contributions, available equally to every plugin. */
import {
	Array,
	Chunk,
	Context,
	Effect,
	FiberSet,
	Layer,
	Ref,
	References,
	Schema,
	Scope,
	SubscriptionRef,
	Tracer,
} from "effect"
import {
	HttpRouter,
	HttpServerRequest,
	type HttpServerResponse,
} from "effect/http"
import type { NetAddress } from "effect/net"

import { Event, type Graft } from "@graftland/graft"

import { Principal } from "./Authorization"
import { recording } from "./internal/recording"

/** A route claimed by a mount, using HttpRouter's methods and paths. */
export interface Route {
	readonly method: HttpRouter.Route<never>["method"]
	readonly path: HttpRouter.PathInput
}

/** Routes and their application. The application runs in the HTTP request fiber. */
export interface Mount {
	readonly routes: ReadonlyArray<Route>
	readonly handle: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		unknown,
		HttpServerRequest.HttpServerRequest | Scope.Scope
	>
}

/** Asks plugins for their live mounts. */
export const Mounts = Event.make<[], Mount>(
	"@graftland/plugin-http/Http/Mounts",
)
/** Emit after adding or removing a Mounts answer. */
export const MountsChanged = Event.make<[]>(
	"@graftland/plugin-http/Http/MountsChanged",
)

/** The listening address. Injecting this service restarts a plugin with the server. */
export class Server extends Context.Service<
	Server,
	{
		readonly url: string
		readonly address: NetAddress.SocketAddress
	}
>()("@graftland/plugin-http/Http/Server") {}

/** Several mounts claim the same route; all involved mounts are excluded. */
export class RouteConflict extends Schema.TaggedError<
	RouteConflict,
	{ readonly brand: unique symbol }
>()("RouteConflict", {
	routes: Schema.Array(Schema.String),
	cause: Schema.optionalKey(Schema.Defect()),
}) {
	override get message(): string {
		return `Several plugins mount ${Array.join(this.routes, ", ")}; none of the conflicting mounts is served`
	}
}

/** One mount's own routes cannot be indexed, such as a duplicate route; that mount alone is excluded. */
export class InvalidMount extends Schema.TaggedError<
	InvalidMount,
	{ readonly brand: unique symbol }
>()("InvalidMount", {
	routes: Schema.Array(Schema.String),
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return `A plugin mounts routes that cannot be served (${Array.join(this.routes, ", ")}); that mount is excluded`
	}
}

/** Advertise an application until the calling scope closes. Prefer mount for owned requests. */
export const advertise = (mount: Mount) =>
	Effect.gen(function* () {
		// Remove the answer before asking the server to rebuild its index.
		yield* Effect.addFinalizer(() => Event.emit(MountsChanged))
		yield* Event.on(Mounts, () => Effect.succeed(mount))
		yield* Event.emit(MountsChanged)
	})

const withoutRequestServices = Context.omit(
	Principal,
	HttpServerRequest.HttpServerRequest,
	HttpServerRequest.ParsedSearchParams,
	HttpRouter.RouteContext,
	Scope.Scope,
	References.CurrentLogLevel,
	Tracer.ParentSpan,
)

/**
 * Build ordinary HttpRouter layers and serve their routes until the calling
 * plugin unloads. Requests and response streams stop before layer resources close.
 * Route handlers receive the mounting plugin's services and the current request scope.
 */
export const mount = <A, E, R>(
	routes: Layer.Layer<A, E, R>,
): Effect.Effect<
	Context.Context<A | Mounted>,
	HttpRouter.Request.Without<E>,
	| Graft.Graft
	| Scope.Scope
	| Exclude<HttpRouter.Request.Without<R>, HttpRouter.HttpRouter>
	| HttpRouter.Request.Only<"Requires" | "GlobalRequires", R>
> =>
	Effect.gen(function* () {
		const services = yield* Effect.context<never>()
		const scope = yield* Scope.Scope
		const router = yield* HttpRouter.make
		const recorded = yield* Ref.make(Chunk.empty<Route>())
		const built = yield* Layer.build(
			Layer.provide(
				// HttpRouter encodes request requirements as phantom layer services.
				// They are captured below, while only ordinary services build the layer.
				// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off -- unwrap HttpRouter request markers just as HttpRouter.serve does; request services are captured by mount
				routes as Layer.Layer<
					A,
					HttpRouter.Request.Without<E>,
					| HttpRouter.HttpRouter
					| Exclude<HttpRouter.Request.Without<R>, HttpRouter.HttpRouter>
				>,
				Layer.succeed(HttpRouter.HttpRouter)(recording(router, recorded, "")),
			),
		).pipe(
			Effect.updateContext(
				(
					context: Context.Context<
						| Exclude<HttpRouter.Request.Without<R>, HttpRouter.HttpRouter>
						| Scope.Scope
					>,
				) =>
					// Strip request context captured by route builders; preserve their build scope.
					Context.add(
						withoutRequestServices(context),
						Scope.Scope,
						scope,
					) as typeof context,
			),
		)
		// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- HttpRouter erases heterogeneous route errors; HttpEffect reports them
		const app = router.asHttpEffect()
		// toHandled re-fails after reporting a request failure. FiberSet records it;
		// we never join the set, because HTTP already owns reporting that cause.
		const requests = yield* FiberSet.make()
		const handle = Effect.withFiber((fiber) =>
			FiberSet.add(requests, fiber),
		).pipe(
			Effect.andThen(
				Effect.updateContext(
					// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- preserve HttpRouter's erased errors for HttpEffect
					app,
					(
						request: Context.Context<
							HttpServerRequest.HttpServerRequest | Scope.Scope
						>,
					) => Context.merge(request, withoutRequestServices(services)),
				),
			),
		)
		const claimed = yield* Ref.get(recorded)
		const contribution: Mount = {
			routes: Chunk.toReadonlyArray(claimed),
			// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Mount deliberately carries heterogeneous route errors
			handle,
		}
		yield* advertise(contribution)
		return Context.add(built, Mounted, contribution)
	})

/** The mounts actually served and the conflicts excluding the others. */
export interface RouteState {
	readonly served: ReadonlyArray<Mount>
	readonly conflicts: ReadonlyArray<RouteConflict | InvalidMount>
}

/** Observe route changes without restarting the contributing plugins. */
export class Routes extends Context.Service<
	Routes,
	SubscriptionRef.SubscriptionRef<RouteState>
>()("@graftland/plugin-http/Http/Routes") {}

/** The request application shared by sibling listener plugins. */
export class Routing extends Context.Service<
	Routing,
	{ readonly handle: Mount["handle"] }
>()("@graftland/plugin-http/Http/Routing") {}

/** The mount built by mount, returned in its context for contribution metadata. */
export class Mounted extends Context.Service<Mounted, Mount>()(
	"@graftland/plugin-http/Http/Mounted",
) {}
