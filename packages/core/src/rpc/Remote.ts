/**
 * Remote services over `effect/rpc`.
 *
 * A remote service is one service key, one `RpcGroup`, and a pair of mappings
 * between the service and its RPCs. The server exposes each service while it is
 * available locally; the client mirrors that availability, publishing a remote
 * service into its own graph while the server reports it, and withdrawing it as
 * soon as the connection breaks.
 */
import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	HashMap,
	HashSet,
	Layer,
	Option,
	Order,
	Ref,
	Schedule,
	Schema,
	Scope,
	Stream,
} from "effect"
import {
	Rpc,
	RpcClient,
	RpcGroup,
	RpcSchema,
	RpcServer,
	type RpcClientError,
} from "effect/rpc"

import * as Graft from "../Graft"
import * as Mount from "../Mount"
import { useStream } from "./lease"

/** A remote service could not be reached because the connection is gone. */
export class RemoteUnavailable extends Schema.TaggedError<
	RemoteUnavailable,
	{ readonly brand: unique symbol }
>()("RemoteUnavailable", {
	service: Schema.optionalKey(Schema.String),
	/** The cause of the disconnect, when one is known. */
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {
	override get message() {
		return this.service === undefined
			? "The remote service is unavailable"
			: `Remote service "${this.service}" is unavailable`
	}
}

/** Errors a generated remote client can fail with. */
export type RemoteClientError =
	RpcClientError.RpcClientError | RemoteUnavailable

/**
 * The service as seen by its local provider: remote-only transport errors are
 * not part of what the provider can fail with.
 */
export type ServerService<Shape> = {
	readonly [K in keyof Shape]: Shape[K] extends (
		...args: infer A
	) => Effect.Effect<infer B, any, infer R>
		? (...args: A) => Effect.Effect<B, never, R>
		: Shape[K] extends (
					...args: infer A
			  ) => Stream.Stream<infer B, any, infer R>
			? (...args: A) => Stream.Stream<B, never, R>
			: Shape[K] extends Effect.Effect<infer B, any, infer R>
				? Effect.Effect<B, never, R>
				: Shape[K] extends Stream.Stream<infer B, any, infer R>
					? Stream.Stream<B, never, R>
					: Shape[K]
}

/**
 * The contract for one remote service: the local key it is published under, the
 * RPC group that carries it, and the two directions of the mapping.
 */
export interface RemoteService<Identifier, Shape, R extends Rpc.Any = Rpc.Any> {
	readonly key: Context.Key<Identifier, Shape>
	readonly group: RpcGroup.RpcGroup<R>
	/** Tag prefix for this service's RPCs, unique per service on a connection. */
	readonly prefix: string
	/** Builds the server handlers for one available instance of the service. */
	readonly toHandlers: (
		service: ServerService<Shape>,
	) => RpcGroup.HandlersFrom<R>
	/** Builds the client-side service from the generated RPC client. */
	readonly fromClient: (
		client: RpcClient.RpcClient<R, RemoteClientError>,
	) => Shape
}

/**
 * Options for {@link service}.
 *
 * `Handlers` and `Client` exist so the handler and client shapes written at the
 * call site are inferred from their constraints. That way the payload and
 * options parameters of every handler are contextually typed without the
 * caller annotating them.
 */
export interface ServiceOptions<
	R extends Rpc.Any,
	Shape,
	Handlers extends RpcGroup.HandlersFrom<R> = RpcGroup.HandlersFrom<R>,
	Client extends Shape = Shape,
> {
	readonly toHandlers: (service: ServerService<Shape>) => Handlers
	readonly fromClient: (
		client: RpcClient.RpcClient<R, RemoteClientError>,
	) => Client
	/**
	 * Tag prefix for the RPCs of this service. Defaults to the service key,
	 * which keeps tags from different services apart on a shared connection.
	 */
	readonly prefix?: string | undefined
}

/**
 * Declares the contract for one remote service. The same value is shared by the
 * server and the client.
 */
export const service = <
	Self,
	Shape,
	Identifier extends string,
	R extends Rpc.Any,
	const Handlers extends RpcGroup.HandlersFrom<R>,
	const Client extends Shape,
>(
	key: Context.ServiceClass<Self, Identifier, Shape>,
	group: RpcGroup.RpcGroup<R>,
	options: ServiceOptions<R, Shape, Handlers, Client>,
): RemoteService<Self, Shape, R> => ({
	key,
	group,
	prefix: options.prefix ?? key.key,
	toHandlers: options.toHandlers,
	fromClient: options.fromClient,
})

/** Any service contract, with its type parameters erased. */
export type AnyRemoteService = RemoteService<any, any, any>

const PresenceTag = "Presence"

/**
 * The single control procedure of a connection. The server pushes the set of
 * service keys it currently provides; the client publishes and withdraws
 * accordingly.
 */
const Presence = Rpc.make(PresenceTag, {
	success: Schema.Array(Schema.String),
	stream: true,
})

/** Combines the control group with each service's group, under its prefix. */
const combinedGroup = (
	services: ReadonlyArray<AnyRemoteService>,
): RpcGroup.RpcGroup<Rpc.AnyWithProps> => {
	let group: RpcGroup.RpcGroup<Rpc.AnyWithProps> = RpcGroup.make(
		Presence,
	) as RpcGroup.RpcGroup<any>
	for (const service of services)
		group = group.merge(service.group.prefix(service.prefix))
	return group
}

/** The server's view of what is available, as a stream of key sets. */
const presenceStream = (
	services: ReadonlyArray<AnyRemoteService>,
): Stream.Stream<Array<string>, never, Graft.Graft> => {
	if (services.length === 0) return Stream.make([] as Array<string>)
	return Stream.fromIterable(services).pipe(
		Stream.flatMap(
			(service) =>
				Graft.watch(service.key).pipe(
					Stream.map(
						(value) => [service.key.key, Option.isSome(value)] as const,
					),
				),
			{ concurrency: "unbounded" },
		),
		Stream.scan(
			() => HashSet.empty<string>(),
			(keys, [key, present]) =>
				present ? HashSet.add(keys, key) : HashSet.remove(keys, key),
		),
		Stream.map((keys) => Array.sort(Array.fromIterable(keys), Order.String)),
		Stream.changes,
	)
}

/** Builds the handler object for a combined group. */
const handlersFor = (services: ReadonlyArray<AnyRemoteService>) => {
	const handlers: Record<string, (payload: any, options: any) => any> = {
		[PresenceTag]: () => presenceStream(services),
	}
	for (const contract of services) {
		for (const [tag, rpc] of contract.group.requests) {
			const prefixed = contract.prefix + tag
			const callEffect = (
				instance: unknown,
				payload: any,
				options: any,
			): Effect.Effect<unknown, never, never> =>
				(contract.toHandlers(instance as any) as any)[tag](payload, options)
			const callStream = (
				instance: unknown,
				payload: any,
				options: any,
			): Stream.Stream<unknown, never, never> =>
				(contract.toHandlers(instance as any) as any)[tag](payload, options)
			handlers[prefixed] = RpcSchema.isStreamSchema(rpc.successSchema)
				? (payload: any, options: any) => {
						// The lease is the stream counterpart of `Graft.use`; only its
						// withdrawal error is turned into a defect, declared errors pass.
						const stream = useStream(contract.key, (instance) =>
							callStream(instance, payload, options),
						)
						return stream.pipe(
							Stream.catchIf(
								(error): error is Graft.ServiceWithdrawn =>
									Schema.is(Graft.ServiceWithdrawn)(error),
								(error) => Stream.failCause(Cause.die(error)),
							),
						)
					}
				: (payload: any, options: any) => {
						// Hold the service for the whole call, so withdrawal cannot
						// release its resources underneath the handler.
						const effect = Graft.use(contract.key, (instance) =>
							callEffect(instance, payload, options),
						)
						// Only withdrawal becomes a defect; declared errors pass through.
						return effect.pipe(
							Effect.catchIf(
								(error): error is Graft.ServiceWithdrawn =>
									Schema.is(Graft.ServiceWithdrawn)(error),
								(error) => Effect.die(error),
							),
						)
					}
		}
	}
	return handlers
}

/** Options for {@link serve}. */
export interface ServeOptions<E = never, R = never> {
	readonly services: ReadonlyArray<AnyRemoteService>
	/** A server protocol layer, for example a socket, stdio or in-memory one. */
	readonly protocol: Layer.Layer<RpcServer.Protocol, E, R>
}

/**
 * Exposes the declared services over an RPC server. Each service is advertised
 * while it is available in the graph, and served from the instance that is
 * available when a call arrives.
 */
export const serve = <E = never, R = never>(
	options: ServeOptions<E, R>,
): Effect.Effect<
	Mount.Mount<E | Graft.ServiceConflict>,
	never,
	Graft.Graft | Scope.Scope | R
> =>
	Effect.gen(function* () {
		// The mount layer is built in this context, so the protocol's
		// requirements must appear in this effect's requirements.
		yield* Effect.context<R>()
		const layerEffect = Layer.effectDiscard(
			Effect.gen(function* () {
				// Capture the graph in each handler's context.
				yield* Graft.Graft
				const group = combinedGroup(options.services)
				const handlersEffect = group.toHandlers(
					handlersFor(
						options.services,
					) as RpcGroup.HandlersFrom<Rpc.AnyWithProps>,
				)
				const handlers = yield* handlersEffect as Effect.Effect<
					Context.Context<any>,
					never,
					never
				>
				const protocol = yield* Layer.build(options.protocol)
				// A serving fiber belongs to the mount: its failure fails the
				// mount instead of disappearing into a scoped fork.
				yield* Graft.fork(
					RpcServer.make(group, {
						disableFatalDefects: true,
					}).pipe(
						Effect.provide(handlers),
						Effect.provideContext(protocol),
					) as Effect.Effect<never, never, never>,
				)
			}),
		)
		// The mount layer runs in the caller's context, which carries R.
		// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off -- R is discharged by the caller's context
		const layer = layerEffect as Layer.Layer<
			never,
			E,
			Graft.Graft | Graft.Tasks<never>
		>
		return yield* Graft.mount(layer, { name: "remote serve" })
	})

/** Options for {@link connect}. */
export interface ConnectOptions<
	Services extends ReadonlyArray<AnyRemoteService>,
	E,
	R,
> {
	readonly services: Services
	/**
	 * Builds a fresh client protocol for each connection attempt. Its scope is
	 * closed when the connection ends.
	 */
	readonly protocol: Effect.Effect<
		RpcClient.Protocol["Service"],
		E,
		R | Scope.Scope
	>
	/** Reconnects on this schedule after the presence stream ends or fails. */
	readonly retry?: Schedule.Schedule<unknown, unknown> | undefined
}

/** Fires when the connection is gone, so in-flight calls fail with `RemoteUnavailable`. */
type Disconnected = Deferred.Deferred<never, RemoteUnavailable>

const remoteError = (
	service: string,
	cause?: Cause.Cause<unknown>,
): RemoteUnavailable =>
	RemoteUnavailable.make({
		service,
		...(cause === undefined ? {} : { cause }),
	})

/** Wraps every RPC method so a call made during a disconnect fails clearly. */
const clientView = <R extends Rpc.Any>(
	service: AnyRemoteService,
	client: RpcClient.RpcClient<R, RemoteClientError>,
	disconnected: Disconnected,
): RpcClient.RpcClient<R, RemoteClientError> => {
	const view: Record<string, unknown> = {}
	for (const tag of service.group.requests.keys()) {
		const method = service.prefix + tag
		view[tag] = (...args: ReadonlyArray<unknown>) => {
			const result = (client as any)[method](...args)
			const gone = Deferred.await(disconnected)
			return Effect.isEffect(result)
				? // The dynamic group erases each client method's error channel.
					// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- erased client methods
					Effect.raceFirst(result, gone)
				: Stream.interruptWhen(result, gone)
		}
	}
	return view as RpcClient.RpcClient<R, RemoteClientError>
}

/** Tracks the published remote services of one connection. */
interface Publications {
	readonly scopes: Ref.Ref<HashMap.HashMap<string, Scope.Closeable>>
}

const withdrawAll = ({ scopes }: Publications) =>
	Effect.gen(function* () {
		const current = yield* Ref.getAndSet(scopes, HashMap.empty())
		for (const [, scope] of current) yield* Scope.close(scope, Exit.void)
	})

const reconcile = (
	services: ReadonlyArray<AnyRemoteService>,
	client: RpcClient.RpcClient<Rpc.Any, RpcClientError.RpcClientError>,
	disconnected: Disconnected,
	publications: Publications,
	keys: ReadonlyArray<string>,
) =>
	Effect.gen(function* () {
		const wanted = HashSet.fromIterable(keys)
		const present = yield* Ref.get(publications.scopes)
		for (const [key, scope] of present) {
			if (HashSet.has(wanted, key)) continue
			yield* Ref.update(publications.scopes, HashMap.remove(key))
			yield* Scope.close(scope, Exit.void)
		}
		const remaining = yield* Ref.get(publications.scopes)
		for (const key of wanted) {
			if (HashMap.has(remaining, key)) continue
			const found = Array.findFirst(services, (entry) => entry.key.key === key)
			if (Option.isNone(found)) continue
			const service = found.value
			const scope = yield* Scope.make()
			const value = service.fromClient(
				clientView(service, client, disconnected) as any,
			)
			yield* Scope.provide(Graft.publish(service.key, value), scope)
			yield* Ref.update(publications.scopes, HashMap.set(key, scope))
		}
	})

/** Runs one connection until its presence stream ends or fails. */
const makeClientEffect = (
	group: RpcGroup.RpcGroup<Rpc.AnyWithProps>,
): Effect.Effect<
	RpcClient.RpcClient<Rpc.Any, RpcClientError.RpcClientError>,
	never,
	never
> =>
	// The combined group is dynamic, so its middleware and schema services are
	// erased here; the transport and schemas carry them at runtime.
	// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off -- erased dynamic group
	RpcClient.make(group) as Effect.Effect<
		RpcClient.RpcClient<Rpc.Any, RpcClientError.RpcClientError>,
		never,
		never
	>

const failureCause = (exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit) ? exit.cause : undefined

/** Consumes the presence stream of one connection until it ends or fails. */
const runConnection = (
	services: ReadonlyArray<AnyRemoteService>,
	client: RpcClient.RpcClient<Rpc.Any, RpcClientError.RpcClientError>,
	disconnected: Disconnected,
	publications: Publications,
): Effect.Effect<
	never,
	RpcClientError.RpcClientError | RemoteUnavailable,
	Graft.Graft
> =>
	Effect.gen(function* () {
		const presence = (client as any)[PresenceTag]() as Stream.Stream<
			ReadonlyArray<string>,
			RpcClientError.RpcClientError,
			never
		>
		const outcome = yield* Effect.exit(
			presence.pipe(
				Stream.runForEach((keys: ReadonlyArray<string>) =>
					reconcile(services, client, disconnected, publications, keys),
				),
				Effect.onExit((exit) =>
					Effect.uninterruptible(
						Effect.gen(function* () {
							yield* Deferred.fail(
								disconnected,
								remoteError("connection", failureCause(exit)),
							)
							yield* withdrawAll(publications)
						}),
					),
				),
			),
		)
		// A clean end, a failure, or a non-teardown interruption are all a
		// disconnect: fail with the original cause so the mount retries.
		return yield* remoteError("connection", failureCause(outcome))
	})

/**
 * Connects to a remote server and mirrors its services into the local graph.
 *
 * The mount layer opens the protocol, publishes each remote service through
 * `Graft.publish`, and owns a background fiber that follows the presence
 * stream. When that fiber fails, the mount enters `Failed` with the original
 * cause and `retry` rebuilds it. While disconnected, in-flight calls fail with
 * `RemoteUnavailable`.
 */
export const connect = <
	const Services extends ReadonlyArray<AnyRemoteService>,
	E,
	R,
>(
	options: ConnectOptions<Services, E, R>,
): Effect.Effect<
	Mount.Mount<
		| E
		| RpcClientError.RpcClientError
		| RemoteUnavailable
		| Graft.ServiceConflict
	>,
	never,
	Graft.Graft | Scope.Scope | R
> =>
	Effect.gen(function* () {
		// The mount layer is built in this context, so its protocol requirements
		// must appear in this effect's requirements.
		yield* Effect.context<R>()
		const connection = Layer.effectDiscard(
			Effect.gen(function* () {
				const protocol = yield* options.protocol
				const group = combinedGroup(options.services)
				const client: RpcClient.RpcClient<
					Rpc.Any,
					RpcClientError.RpcClientError
				> = yield* makeClientEffect(group).pipe(
					Effect.provideService(RpcClient.Protocol, protocol),
				)
				const publications: Publications = {
					scopes: yield* Ref.make<HashMap.HashMap<string, Scope.Closeable>>(
						HashMap.empty(),
					),
				}
				yield* Effect.addFinalizer(() => withdrawAll(publications))
				const disconnected = yield* Deferred.make<never, RemoteUnavailable>()
				// The connection is a background fiber of this mount, so its
				// failure reaches the mount as a whole.
				yield* Graft.fork(
					runConnection(options.services, client, disconnected, publications),
				)
			}),
		)
		// The mount layer runs in the caller's context, which carries R.
		// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off -- R is discharged by the caller's context
		const layer = connection as Layer.Layer<
			never,
			E | RpcClientError.RpcClientError | RemoteUnavailable,
			| Graft.Graft
			| Graft.Tasks<RpcClientError.RpcClientError | RemoteUnavailable>
		>
		return yield* Graft.mount(layer, {
			name: "remote connect",
			retry: options.retry,
		})
	})
