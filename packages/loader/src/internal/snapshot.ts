import { Array, MutableList, Predicate } from "effect"

/** Class instances are opaque; only arrays and plain records belong to the data graph. */
export const isContainer = (value: unknown): value is object =>
	Predicate.isObjectOrArray(value) &&
	(Array.isArray(value) ||
		Object.getPrototypeOf(value) === Object.prototype ||
		Object.getPrototypeOf(value) === null)

// Identity tracking is intentional: structural hashes require immutable input.
// Only graphs built here can be reused; a caller's shallow freeze proves nothing.
const owned = new WeakSet<object>()

/**
 * Copy and freeze a data graph without changing the caller's objects. Sharing,
 * cycles, sparse arrays and null prototypes survive the copy. Own properties
 * are captured as values; class instances (including Env) retain their identity.
 */
export const snapshot = <A>(value: A): A => {
	const copies = new WeakMap<object, object>()
	const pending = MutableList.make<{
		readonly source: object
		readonly copy: object
	}>()
	const copyOf = (source: unknown): unknown => {
		if (!isContainer(source) || owned.has(source)) return source
		const existing = copies.get(source)
		if (existing !== undefined) return existing
		const copy: object = Array.isArray(source)
			? []
			: Object.create(Object.getPrototypeOf(source))
		copies.set(source, copy)
		MutableList.append(pending, { source, copy })
		return copy
	}
	const result = copyOf(value)
	while (pending.length > 0) {
		const item = MutableList.take(pending)
		if (item === MutableList.Empty) break
		const { source, copy } = item
		for (const key of Reflect.ownKeys(source)) {
			Object.defineProperty(copy, key, {
				value: copyOf(Reflect.get(source, key)),
				enumerable: Object.prototype.propertyIsEnumerable.call(source, key),
				configurable: !(Array.isArray(source) && key === "length"),
				writable: true,
			})
		}
		Object.freeze(copy)
		owned.add(copy)
	}
	return result as A
}
