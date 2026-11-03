import { Array, Context, Effect, Record } from "effect"
import { Graft } from "@graftland/graft"
import { RpcClient, RpcServer } from "effect/rpc"
import type { Scope } from "effect"
import type { Rpc, RpcClientError, RpcGroup } from "effect/rpc"
import type * as Port from "./port"

type Peer = Port.Port

/** RPC types stay inside the descriptor; Graft supplies its dynamic activation context. */
export interface Service<R = never, ClientR = never> {
	readonly key: Context.Key<unknown, unknown>
	readonly group: Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">
	readonly serve: (
		port: Pick<Peer, "serverProtocol">,
	) => Effect.Effect<never, never, R>
	readonly publish: (
		port: Pick<Peer, "clientProtocol">,
	) => Effect.Effect<
		void,
		Graft.ServiceConflict,
		Graft.Graft | Scope.Scope | ClientR
	>
}
export const service = <
	I,
	S,
	R extends Rpc.Any,
	H extends RpcGroup.HandlersFrom<R>,
>(
	key: Context.Key<I, S>,
	group: RpcGroup.RpcGroup<R>,
	mapping: {
		readonly toHandlers: (value: S) => H
		readonly fromClient: (
			client: RpcClient.RpcClient<R, RpcClientError.RpcClientError>,
		) => S
	},
): Service<
	RpcGroup.HandlersServices<R, H> | Rpc.Middleware<R> | Rpc.ServicesServer<R>,
	Rpc.MiddlewareClient<R>
> => ({
	key,
	group,
	serve: Effect.fnUntraced(function* (port) {
		// Graft admits the activation from this descriptor's key before serving it.
		const context = yield* Effect.context<never>()
		const value = yield* Effect.fromOption(
			Context.getOption(context, key),
		).pipe(Effect.orDie)
		const handlers = yield* group.toHandlers(mapping.toHandlers(value))
		return yield* RpcServer.make(group, { disableFatalDefects: true }).pipe(
			Effect.provideContext(handlers),
			Effect.provideService(RpcServer.Protocol, port.serverProtocol(key.key)),
		)
	}),
	publish: Effect.fnUntraced(function* (port) {
		const client = yield* RpcClient.make(group).pipe(
			Effect.provideService(RpcClient.Protocol, port.clientProtocol(key.key)),
		)
		yield* Graft.provide(key, mapping.fromClient(client))
	}),
})
export const endpoints = (services: ReadonlyArray<Service>) =>
	Record.fromEntries(
		Array.map(
			services,
			(service) =>
				[service.key.key, service.group] satisfies readonly [
					string,
					Service["group"],
				],
		),
	)
