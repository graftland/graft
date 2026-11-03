import { Effect } from "effect"

/** Request metadata follows decoded values, never the executor's ambient context. */
// Monotonic request identities let a later ordinary edit retain its old loader
// epoch without undoing a refresh requested directly through the public root.
let revision = 0
export const nextEpoch = (): number => ++revision

const epochs = new WeakMap<object, number>()

export const epochOf = (value: unknown): number | undefined =>
	typeof value === "object" && value !== null ? epochs.get(value) : undefined

/** Only stamp a fresh request object; persisted descriptions never carry mutable metadata. */
export const withEpoch = <A extends object>(value: A, epoch: number): A => {
	epochs.set(value, epoch)
	return value
}

export const preserveEpoch =
	<A extends object, B extends object, E, R>(
		decode: (input: A) => Effect.Effect<B, E, R>,
	) =>
	(input: A): Effect.Effect<B, E, R> => {
		const epoch = epochOf(input)
		return Effect.map(decode(input), (value) =>
			epoch === undefined ? value : withEpoch(value, epoch),
		)
	}
