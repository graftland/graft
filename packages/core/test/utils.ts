import { assert } from "@effect/vitest"
import { Array, Effect, Layer, Option, Ref, Stream } from "effect"
import type { Scope } from "effect"
import { Graft, type Fork } from "../src/index.ts"

/** Runs a test inside a fresh root graft. */
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

/** Waits until the fork reaches a state with the given tag. */
export const reach = (fork: Fork.Fork, tag: Fork.ForkState["_tag"]) =>
	fork.state.pipe(
		Stream.filter((state) => state._tag === tag),
		Stream.runHead,
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Effect.die(new Error(`Fork ${fork.id} ended before reaching ${tag}`)),
				onSome: () => Effect.void,
			}),
		),
	)
