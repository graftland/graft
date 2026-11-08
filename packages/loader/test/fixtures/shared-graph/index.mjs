import {
	Array,
	Context,
	Effect,
	HashSet,
	Predicate,
	Record,
	Ref,
	Schema,
} from "effect"

import { Plugin } from "@graftland/graft"

const State = Context.Service("loader/shared-graph")
const size = (pending, seen) => {
	const [value, ...tail] = pending
	if (pending.length === 0) return HashSet.size(seen)
	if (!Predicate.isObjectOrArray(value) || HashSet.has(seen, value))
		return size(tail, seen)
	return size([...tail, ...Record.values(value)], HashSet.add(seen, value))
}
export default Plugin.make({
	inject: [State],
	name: "graph",
	config: Schema.Unknown,
	apply: (value) =>
		Effect.gen(function* () {
			const { observed, starts } = yield* State
			yield* Ref.set(observed, size([value], HashSet.empty()))
			yield* Ref.update(starts, (n) => n + 1)
		}),
})
