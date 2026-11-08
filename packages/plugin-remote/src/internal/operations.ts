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
		return rpc.annotate(Invalid, "AlreadyDeclared")
	return rpc.annotate(Identity, Object.freeze({ name, version }))
}

const key = (identity: Plugin.OperationIdentity) =>
	`${identity.name}@${identity.version}`

export interface OperationProblem {
	readonly reason:
		| "MissingIdentity"
		| "AlreadyDeclared"
		| "InvalidIdentity"
		| "DuplicateIdentity"
	readonly tag: string
}
class Invalid extends Context.Service<Invalid, "AlreadyDeclared">()(
	"@graftland/plugin-remote/internal/operations/Invalid",
) {}
export const problem = (rpc: Rpc.Any): Option.Option<OperationProblem> => {
	if (Option.isSome(Context.getOption(rpc.annotations, Invalid)))
		return Option.some({ tag: rpc._tag, reason: "AlreadyDeclared" })
	const value = identity(rpc)
	if (Option.isNone(value))
		return Option.some({ tag: rpc._tag, reason: "MissingIdentity" })
	const id = value.value
	return /^\S+$/.test(id.name) &&
		Number.isSafeInteger(id.version) &&
		id.version > 0
		? Option.none()
		: Option.some({ tag: rpc._tag, reason: "InvalidIdentity" })
}
/** Reads declared metadata; the unit's declaration check reports missing or invalid identities. */
export const identities = (
	group: Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">,
): ReadonlyArray<Plugin.OperationIdentity> =>
	Array.flatMap(Array.fromIterable(group.requests.values()), (rpc) =>
		Option.toArray(identity(rpc)),
	)
export const check = (
	group: Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">,
): Option.Option<OperationProblem> => {
	const invalid = Array.findFirst(
		Array.flatMap(Array.fromIterable(group.requests.values()), (rpc) =>
			Option.toArray(problem(rpc)),
		),
		() => true,
	)
	if (Option.isSome(invalid)) return invalid
	const ids = identities(group)
	return HashSet.size(HashSet.fromIterable(Array.map(ids, key))) === ids.length
		? Option.none()
		: Option.some({ tag: "", reason: "DuplicateIdentity" })
}
