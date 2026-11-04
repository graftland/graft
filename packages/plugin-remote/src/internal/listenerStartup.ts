import type { Fork } from "@graftland/graft"
import { Array, Deferred, Effect, HashSet, Option, Stream } from "effect"
import type { AuthenticatorApi } from "../Auth"
import type { Properties } from "../Transport"
import { CapabilityCombinationError, CapabilityFailed } from "./assembly"

export interface Description {
	readonly properties: Properties
	readonly auth: AuthenticatorApi
}
export const signals = Effect.all({
	description: Deferred.make<Description>(),
	ready: Deferred.make<void>(),
})
/** A startup signal races its assembly's failure; no runtime failure is promoted to the owner. */
export const wait = <A>(fork: Fork.Fork, signal: Deferred.Deferred<A>) =>
	Deferred.await(signal).pipe(
		Effect.raceFirst(
			fork.state.pipe(
				Stream.runForEach((state) =>
					state._tag === "Failed"
						? Effect.fail(CapabilityFailed.make({ cause: state.cause }))
						: Effect.void,
				),
				Effect.andThen(Effect.never),
			),
		),
	)
export const validate = (listeners: ReadonlyArray<Description>) => {
	if (
		listeners.length !== 1 &&
		Array.some(listeners, ({ properties }) => properties.protocol === "stdio")
	)
		return Effect.fail(
			CapabilityCombinationError.make({
				detail: "A stdio listener must be the only listener in the runner",
			}),
		)
	const issuers = HashSet.fromIterable(
		Array.getSomes(
			Array.map(listeners, ({ auth }) =>
				auth._tag === "Header"
					? Option.fromUndefinedOr(auth.issuer)
					: Option.none(),
			),
		),
	)
	return HashSet.size(issuers) > 1
		? Effect.fail(
				CapabilityCombinationError.make({
					detail: "A runner must use a single authentication issuer",
				}),
			)
		: Effect.void
}
