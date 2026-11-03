import { Array, Context, Effect, Layer, Stream, Record, Queue } from "effect"
import { Graft } from "@graftland/graft"
import { RpcClient, RpcGroup, RpcSchema } from "effect/rpc"
import type { Rpc, RpcClientError } from "effect/rpc"

/** Existential service descriptor: typed construction retains the key/mapping relationship. */
export interface Service {
	readonly key: Context.Key<unknown, unknown>
	readonly group: RpcGroup.RpcGroup<Rpc.Any>
	readonly bind: (
		context: Context.Context<never>,
	) => Effect.Effect<Context.Context<never>>
	readonly publish: (
		client: object,
	) => Effect.Effect<void, Graft.ServiceConflict, Graft.Graft>
}
export const service = <I, S, R extends Rpc.Any>(
	key: Context.Key<I, S>,
	group: RpcGroup.RpcGroup<R>,
	mapping: {
		readonly toHandlers: (value: S) => RpcGroup.HandlersFrom<R>
		readonly fromClient: (
			client: RpcClient.RpcClient<R, RpcClientError.RpcClientError>,
		) => S
	},
): Service => ({
	key,
	// RpcGroup is invariant; the descriptor closes over its concrete group below.
	group: RpcGroup.make(
		...Array.fromIterable<Rpc.Any>(group.requests.values()),
	).annotateMerge(group.annotations),
	bind: (context) =>
		group
			.toHandlers(mapping.toHandlers(Context.getUnsafe(context, key)))
			.pipe(
				Effect.provideContext(
					context as Context.Context<
						RpcGroup.HandlersServices<R, RpcGroup.HandlersFrom<R>>
					>,
				),
			),
	// The aggregate client contains this group's tags, checked by combine before construction.
	publish: (client) =>
		Graft.provide(
			key,
			mapping.fromClient(
				client as RpcClient.RpcClient<R, RpcClientError.RpcClientError>,
			),
		),
})
/** Validate the assembled direction while defining its contract, before activation or retry. */
export const validateTags = <R extends Rpc.Any>(
	base: RpcGroup.RpcGroup<R>,
	services: ReadonlyArray<Service>,
) => {
	const groups = [base, ...Array.map(services, (service) => service.group)]
	const tags = Array.flatMap(groups, (group) =>
		Array.fromIterable(group.requests.keys()),
	)
	if (Array.dedupe(tags).length !== tags.length)
		throw new Error("RPC tags must be unique within each remote direction")
}
export const combine = <R extends Rpc.Any>(
	base: RpcGroup.RpcGroup<R>,
	services: ReadonlyArray<Service>,
) =>
	RpcGroup.make(...Array.fromIterable<Rpc.Any>(base.requests.values())).merge(
		...Array.map(services, (service) => service.group),
	)

export const handlers = (
	services: ReadonlyArray<Service>,
	context: Context.Context<never>,
) =>
	Effect.reduce(
		services,
		() => Context.empty(),
		(all, service) =>
			service
				.bind(context)
				.pipe(Effect.map((next) => Context.merge(all, next))),
	)

/** Restore the handler-service type at the aggregate RPC boundary. */
export const layer = (context: Effect.Effect<Context.Context<never>>) =>
	Layer.effectContext(context) as Layer.Layer<Rpc.ToHandler<Rpc.Any>>

/** Calls wait for an export lease, but registering the server must not wait for Load. */
export const deferredHandlers = (
	services: ReadonlyArray<Service>,
	ready: Effect.Effect<Context.Context<never>>,
) =>
	Effect.reduce(
		services,
		() => Context.empty(),
		(all, service) => {
			const handlers = Record.fromEntries(
				Array.map(
					Array.fromIterable(service.group.requests.values()),
					(rpc) => {
						const handler = (
							payload: never,
							options: Parameters<Rpc.ToHandlerFn<Rpc.Any>>[1],
						) => {
							// The same group built this context in bind; accessHandler restores its captured services.
							const call = ready.pipe(
								Effect.flatMap((context) =>
									service.group
										.accessHandler(rpc._tag)
										.pipe(
											Effect.provideContext(
												context as Context.Context<Rpc.Handler<string>>,
											),
										),
								),
								Effect.map((fn) => {
									// Dynamic dispatch erases only the RPC union; failures still pass intact to RpcServer.
									const result:
										| Effect.Effect<unknown, unknown>
										| Stream.Stream<unknown, unknown> = fn(payload, options)
									return result
								}),
							)
							const isStream = RpcSchema.isStreamSchema(
								(rpc as Rpc.AnyWithProps).successSchema,
							)
							if (isStream)
								return Stream.unwrap(
									call.pipe(
										Effect.map((result) =>
											Stream.isStream(result)
												? result
												: Stream.unwrap(
														// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- A dynamic RPC queue retains its failure channel for RpcServer encoding.
														Effect.map(result, (queue) =>
															Queue.isQueue(queue)
																? Stream.fromQueue(queue)
																: Stream.die(
																		new Error("Expected an RPC stream queue"),
																	),
														),
													),
										),
									),
								)
							return Effect.flatMap(call, (result) =>
								Stream.isStream(result)
									? Effect.die(new Error("Unexpected RPC stream"))
									: result,
							)
						}
						return [rpc._tag, handler] as const
					},
				),
			)
			// Each dynamically named handler has the shape dictated by its own success schema.
			return service.group
				.toHandlers(handlers as unknown as RpcGroup.HandlersFrom<Rpc.Any>)
				.pipe(Effect.map((next) => Context.merge(all, next)))
		},
	)
