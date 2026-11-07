/** Operator policy for Remote artifacts, placements and host-owned capabilities. */
import { Effect, Option } from "effect"

import { Trust } from "@graftland/graft"

import { Service } from "./internal/policy"
import { PolicyError } from "./internal/policyModel"

export * from "./internal/policyModel"
export { Service, type Operations, install } from "./internal/policy"
export { termination } from "./internal/policyLimits"
/** Reads the ordinary injected policy service. Missing policy is a recoverable error. */
export const service = Effect.serviceOption(Service).pipe(
	Effect.flatMap(
		Option.match({
			onNone: () =>
				PolicyError.make({
					message: "Operator policy service is missing; inject Policy.Service",
				}),
			onSome: Effect.succeed,
		}),
	),
)
export const { check, publish } = Trust
