import {
	Array,
	Context,
	Effect,
	Option,
	Predicate,
	Record,
	Schema,
} from "effect"
import { Headers } from "effect/http"
import {
	RpcClient,
	RpcClientError,
	RpcMiddleware,
	RpcSchema,
	RpcServer,
	type Rpc,
	type RpcGroup,
} from "effect/rpc"

import { Graft } from "@graftland/graft"

import type { Service } from "../Contract"
import { identities } from "./operations"

export class OwnedRequest extends RpcMiddleware.Service<OwnedRequest>()(
	"@graftland/plugin-remote/internal/services/OwnedRequest",
) {}

export type UnitRequirements<X, R extends Rpc.Any> = Exclude<
	Exclude<Exclude<X, Rpc.ToHandler<R>>, OwnedRequest>,
	RpcServer.Protocol
>
export type UnitServices<
	R extends Rpc.Any,
	H extends RpcGroup.HandlersFrom<R>,
> =
	| RpcGroup.HandlersServices<R, H>
	| UnitRequirements<
			Rpc.ServicesServer<Rpc.AddMiddleware<R, typeof OwnedRequest>>,
			R
	  >
	| UnitRequirements<
			Rpc.ToHandler<Rpc.AddMiddleware<R, typeof OwnedRequest>>,
			R
	  >
	| UnitRequirements<
			Rpc.Middleware<Rpc.AddMiddleware<R, typeof OwnedRequest>>,
			R
	  >
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
	Rpc.MiddlewareClient<R>,
	UnitServices<R, H>
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
		serveUnit: Effect.fnUntraced(function* (port, owner) {
			const context = yield* Effect.context<never>()
			const value = yield* Effect.fromOption(
				Context.getOption(context, key),
			).pipe(Effect.orDie)
			const handlers = yield* group.toHandlers(mapping.toHandlers(value))
			const owned = group.middleware(OwnedRequest)
			return yield* RpcServer.make(owned, { disableFatalDefects: true }).pipe(
				Effect.provideContext(handlers),
				Effect.provideService(OwnedRequest, (effect, options) =>
					Option.match(Headers.get(options.headers, "x-graft-ticket"), {
						onNone: () => Effect.die("The encoded call has no core ticket"),
						onSome: (ticket) => owner.run(effect, ticket, options.rpc._tag),
					}),
				),
				Effect.provideService(RpcServer.Protocol, port.serverProtocol(key.key)),
			)
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
