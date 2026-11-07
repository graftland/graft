/** Operator policy for Remote artifacts, placements and host-owned capabilities. */
import { Effect } from "effect"

import { Trust } from "@graftland/graft"

import * as Internal from "./internal/policy"

export * from "./internal/policyModel"
export { Service, type Operations, install } from "./internal/policy"
export { termination } from "./internal/policyLimits"
const service = Trust.service(Internal.Service).pipe(Effect.orDie)
export const bind = Effect.fnUntraced(function* (
	...args: Parameters<Internal.Operations["bind"]>
) {
	return yield* (yield* service).bind(...args)
})
export const statement = Effect.fnUntraced(function* (
	...args: Parameters<Internal.Operations["statement"]>
) {
	return yield* (yield* service).statement(...args)
})
export const review = Effect.fnUntraced(function* (
	...args: Parameters<Internal.Operations["review"]>
) {
	return yield* (yield* service).review(...args)
})
export const approve = Effect.fnUntraced(function* (
	...args: Parameters<Internal.Operations["approve"]>
) {
	return yield* (yield* service).approve(...args)
})
export const revoke = Effect.fnUntraced(function* (
	...args: Parameters<Internal.Operations["revoke"]>
) {
	if (yield* Trust.enabled) return yield* (yield* service).revoke(...args)
})
export const onRevoke = Effect.fnUntraced(function* (
	...args: Parameters<Internal.Operations["onRevoke"]>
) {
	return yield* (yield* service).onRevoke(...args)
})
export const statements = Effect.flatMap(Trust.enabled, (enabled) =>
	enabled
		? Effect.flatMap(service, (methods) => methods.statements)
		: Effect.succeed([]),
)
export const bindings = Effect.flatMap(service, (methods) => methods.bindings)
export const { check, enabled, publish } = Trust
