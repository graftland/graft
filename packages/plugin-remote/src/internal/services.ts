import { Array, Context, Effect, Predicate, Record, Schema } from "effect"
import {
	RpcClient,
	RpcClientError,
	RpcSchema,
	RpcServer,
	type Rpc,
	type RpcGroup,
} from "effect/rpc"

import { Graft } from "@graftland/graft"

import type { Service } from "../Contract"
import { identities } from "./operations"

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
> => {
	class Client extends Context.Service<
		Client,
		RpcClient.RpcClient<R, RpcClientError.RpcClientError>
	>()(key.key) {}

	return {
		key,
		group,
		operations: identities(group),
		unary: Array.every(
			[...group.requests.values()],
			(rpc) =>
				Predicate.hasProperty(rpc, "successSchema") &&
				Schema.isSchema(rpc.successSchema) &&
				!RpcSchema.isStreamSchema(rpc.successSchema),
		),
		clients: Effect.fnUntraced(function* (port) {
			const client = yield* RpcClient.make(group).pipe(
				Effect.provideService(RpcClient.Protocol, port.clientProtocol(key.key)),
			)
			return Context.make(Client, client)
		}),
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
	}
}
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
