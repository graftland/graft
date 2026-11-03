import { Array, Equal, MutableList, Record } from "effect"
import { isContainer } from "./snapshot"

/**
 * Compare plain data by value, visiting each object pair once. Sharing need not
 * have the same topology; cycles close at an already visited pair. Opaque values
 * retain Effect equality. No structural hash is computed for the data graph.
 */
export const equalConfig = (left: unknown, right: unknown): boolean => {
	const seen = new WeakMap<object, WeakSet<object>>()
	const pending = MutableList.make<readonly [unknown, unknown]>()
	MutableList.append(pending, [left, right])
	while (pending.length > 0) {
		const pair = MutableList.take(pending)
		if (pair === MutableList.Empty) break
		const [left, right] = pair
		if (left === right) continue
		if (
			!isContainer(left) ||
			!isContainer(right) ||
			Equal.isEqual(left) ||
			Equal.isEqual(right)
		) {
			if (!Equal.equals(left, right)) return false
			continue
		}
		const previous = seen.get(left)
		if (previous?.has(right) === true) continue
		if (previous === undefined) seen.set(left, new WeakSet([right]))
		else previous.add(right)
		if (Array.isArray(left)) {
			if (!Array.isArray(right) || left.length !== right.length) return false
			for (let index = 0; index < left.length; index++)
				MutableList.append(pending, [left[index], right[index]])
		} else {
			if (Array.isArray(right)) return false
			const keys = Reflect.ownKeys(left)
			if (keys.length !== Reflect.ownKeys(right).length) return false
			for (const key of keys) {
				if (!Record.has(right as Record<PropertyKey, unknown>, key))
					return false
				MutableList.append(pending, [
					Reflect.get(left, key),
					Reflect.get(right, key),
				])
			}
		}
	}
	return true
}
