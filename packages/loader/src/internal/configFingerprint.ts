import { Array, Equal, Hash, Order } from "effect"

import { isContainer } from "./snapshot"

/** A conservative accelerator, never an equality decision. Cycles and opaque values fall back. */
export const makeFingerprint = () => {
	const memo = new WeakMap<object, number | undefined>()
	const active = new WeakSet<object>()
	const fingerprint = (value: unknown): number | undefined => {
		if (
			value === null ||
			(typeof value !== "object" && typeof value !== "function")
		)
			return Hash.hash(value)
		if (!isContainer(value) || Equal.isEqual(value)) return undefined
		if (active.has(value)) return undefined
		if (memo.has(value)) return memo.get(value)
		active.add(value)
		let hash = Hash.string(Array.isArray(value) ? "array" : "record")
		const keys = Array.isArray(value)
			? Array.makeBy(value.length, String)
			: Reflect.ownKeys(value)
		if (Array.some(keys, (key) => typeof key === "symbol")) {
			active.delete(value)
			memo.set(value, undefined)
			return undefined
		}
		const ordered = Array.isArray(value)
			? (keys as ReadonlyArray<string>)
			: Array.sort(keys as ReadonlyArray<string>, Order.String)
		for (const key of ordered) {
			const inner = fingerprint(Reflect.get(value, key))
			if (inner === undefined) {
				active.delete(value)
				memo.set(value, undefined)
				return undefined
			}
			hash = Hash.combine(Hash.string(key))(hash)
			hash = Hash.combine(inner)(hash)
		}
		active.delete(value)
		memo.set(value, hash)
		return hash
	}
	return fingerprint
}
