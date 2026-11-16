import {
	Array,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Stream,
	TxRef,
	TxSubscriptionRef,
	type Scope,
} from "effect"
import { assert } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import type {
	ActiveResolution,
	Provision,
	Runtime,
	ServiceKey,
} from "../src/internal/runtime.ts"

/** Runs a test inside a fresh root graph. */
export const run = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

export interface Journal {
	readonly record: (event: string) => Effect.Effect<void>
	readonly entries: Effect.Effect<ReadonlyArray<string>>
	readonly expect: (expected: ReadonlyArray<string>) => Effect.Effect<void>
}

/** An append-only list of events, for asserting on ordering. */
export const makeJournal: Effect.Effect<Journal> = Effect.gen(function* () {
	const ref = yield* Ref.make<ReadonlyArray<string>>([])
	return {
		record: (event: string) => Ref.update(ref, Array.append(event)),
		entries: Ref.get(ref),
		expect: (expected) =>
			Effect.map(Ref.get(ref), (entries) =>
				assert.deepStrictEqual(entries, expected),
			),
	}
})

/** Waits until the mount reaches a state with the given tag. */
export const reach = <S extends { readonly _tag: string }>(
	mount: { readonly id: number; readonly state: Stream.Stream<S> },
	tag: S["_tag"],
) =>
	mount.state.pipe(
		Stream.filter((state) => state._tag === tag),
		Stream.runHead,
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Effect.die(
						new Error(`Mount ${mount.id} ended before reaching ${tag}`),
					),
				onSome: () => Effect.void,
			}),
		),
	)

/** Materializes the internal slot directory only for lifecycle assertions. */
export const registrySnapshot = Effect.fn("registrySnapshot")(function* (
	runtime: Runtime,
) {
	const slots = yield* TxRef.get(runtime.slots)
	let provisions = HashMap.empty<ServiceKey, Provision>()
	for (const [key, slot] of slots) {
		const value = yield* TxRef.get(slot.provision)
		if (Option.isSome(value))
			provisions = HashMap.set(provisions, key, value.value)
	}
	return provisions
}, Effect.tx)

/** Display entries contain graph handles, but graph waits never read the display table. */
export const activeSnapshot = Effect.fn("activeSnapshot")(function* (
	runtime: Runtime,
) {
	const mounts = yield* TxSubscriptionRef.get(runtime.mounts)
	let active = HashMap.empty<number, ActiveResolution>()
	for (const [id, entry] of mounts) {
		const state = yield* TxRef.get(entry.node.state)
		if (state.resolution !== undefined)
			active = HashMap.set(active, id, state.resolution)
	}
	return active
}, Effect.tx)
