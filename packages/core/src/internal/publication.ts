/**
 * Publishing a value into the graph on behalf of one activation. The engine
 * exposes it so tests can drive a publication from a captured activation.
 */
import { Array, Effect, HashMap, HashSet, Option, TxRef } from "effect"

import { ServiceConflict } from "./conflicts"
import { publicationCycle, resolutionChanged } from "./dependencies"
import {
	realmKey,
	realmOf,
	Realms,
	type Activation,
	type Provision,
} from "./runtime"
import { RuntimeContext } from "./runtimeContext"
import * as Slots from "./slots"

/**
 * Refuses to publish from an activation whose teardown has begun. Teardown
 * closes the activation to publishing in a transaction, so a read inside the
 * transaction that would publish either sees an open mount or dies here.
 *
 * Callers must run this inside the transaction that acts on the result: the
 * check is only atomic with the effect it guards when they share one.
 */
export const ensureOpen = (activation: Activation, service: string) =>
	Effect.gen(function* () {
		const published = yield* TxRef.get(activation.published)
		if (Option.isNone(published))
			return yield* Effect.die(
				new Error(`Cannot publish "${service}": the mount is being torn down`),
			)
	})

/**
 * Publishes one value under a key, in the realm the key resolves to. `owner`
 * is the activation the publication belongs to: once that mount begins
 * tearing down, the value may not enter the graph, even though the
 * publication's own mount was registered while it was still open.
 */
export const publishValue = Effect.fnUntraced(function* (
	service: string,
	value: unknown,
	owner?: Activation,
): Effect.fn.Return<void, ServiceConflict, RuntimeContext> {
	const { runtime, activation } = yield* RuntimeContext
	const realms = yield* Realms
	const qualified = realmKey(realmOf(realms, service), service)
	yield* Effect.tx(
		Effect.gen(function* () {
			if (owner !== undefined) yield* ensureOpen(owner, service)
			yield* ensureOpen(activation, service)
			const current = yield* TxRef.get(activation.published)
			const published = Option.getOrElse(
				current,
				(): ReadonlyArray<Provision> => [],
			)
			const { resolution } = yield* TxRef.get(activation.node.state)
			if (resolution !== undefined && (yield* resolutionChanged(resolution))) {
				return yield* ServiceConflict.make({ service, reason: "Invalidated" })
			}
			// Retaining and publishing share the caller's transaction, including an outer Effect.tx.
			const directory = yield* TxRef.get(runtime.slots)
			const existing = HashMap.get(directory, qualified)
			if (
				Option.isSome(existing) &&
				(yield* TxRef.get(existing.value.provision))._tag === "Some"
			) {
				return yield* ServiceConflict.make({ service })
			}
			if (yield* publicationCycle(activation.node, qualified)) {
				const direct =
					resolution !== undefined && HashMap.has(resolution.watch, qualified)
				return yield* ServiceConflict.make({
					service,
					realm: realmOf(realms, service),
					mount: activation.mount,
					reason: direct ? "SelfDependency" : "DependencyCycle",
				})
			}
			const slot = yield* Slots.retain(runtime, qualified)
			const provision: Provision = {
				key: qualified,
				service,
				value,
				owner: activation.mount,
				node: activation.node,
				slot,
				consumers: TxRef.makeUnsafe(HashSet.empty<number>()),
			}
			yield* TxRef.set(slot.provision, Option.some(provision))
			yield* TxRef.set(
				activation.published,
				Option.some(Array.append(published, provision)),
			)
		}),
	)
})
