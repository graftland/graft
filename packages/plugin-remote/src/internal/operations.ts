import { Array, Context, HashSet, Option, type Schema } from "effect"
import type { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"

import { Plugin } from "@graftland/graft"

class Identity extends Context.Service<Identity, Plugin.OperationIdentity>()(
	"@graftland/plugin-remote/internal/operations/Identity",
) {}

/** Reads the declared operation identity without interpreting its schemas. */
export const identity = (rpc: Rpc.Any) =>
	Context.getOption(rpc.annotations, Identity)

/** Gives an Effect RPC its immutable protocol identity without changing its wire tag. */
export const operation = <
	Tag extends string,
	Payload extends Schema.Top,
	Success extends Schema.Top,
	Error extends Schema.Top,
	Middleware extends RpcMiddleware.AnyService,
	Requires,
>(
	name: string,
	version: number,
	rpc: Rpc.Rpc<Tag, Payload, Success, Error, Middleware, Requires>,
): Rpc.Rpc<Tag, Payload, Success, Error, Middleware, Requires> => {
	if (Option.isSome(Context.getOption(rpc.annotations, Identity)))
		throw new Error("An RPC operation already has an identity")
	return rpc.annotate(
		Identity,
		Plugin.OperationIdentity.make({ name, version }),
	)
}

const key = (identity: Plugin.OperationIdentity) =>
	`${identity.name}@${identity.version}`

/** Extracts declared identities; every operation in a service must have one. */
export const identities = (
	group: Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">,
): ReadonlyArray<Plugin.OperationIdentity> => {
	const operations = Array.map(
		Array.fromIterable(group.requests.values()),
		(rpc) => {
			const identity = Context.getOption(rpc.annotations, Identity)
			if (Option.isNone(identity))
				throw new Error(
					`RPC "${rpc._tag}" is missing a contract operation identity`,
				)
			return identity.value
		},
	)
	if (
		HashSet.size(HashSet.fromIterable(Array.map(operations, key))) !==
		operations.length
	)
		throw new Error("Operation identities must be unique within a service")
	return operations
}
