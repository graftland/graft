/** Records real collection operations while delegating every operation to Effect. */
import { Array, HashMap, HashSet, Order, Record } from "effect"

import { vi } from "vitest"

import type * as Core from "../src/internal/decisionCore"

interface Recording {
	readonly mock: {
		readonly calls: ReadonlyArray<ReadonlyArray<unknown>>
		readonly invocationCallOrder: ReadonlyArray<number>
		readonly results: ReadonlyArray<{
			readonly type: string
			readonly value?: unknown
		}>
	}
}
interface Operation {
	readonly name: string
	readonly order: number
	readonly args: ReadonlyArray<unknown>
	readonly result: unknown
}
export interface Visit {
	readonly operation: string
	readonly collection: string
	readonly key: string
}
export interface Trace<A> {
	readonly value: A
	readonly visits: ReadonlyArray<Visit>
	readonly scans: ReadonlyArray<string>
}
const record = (name: string, spy: Recording): ReadonlyArray<Operation> =>
	Array.map(spy.mock.calls, (args, i) => ({
		name,
		args,
		order: spy.mock.invocationCallOrder[i] ?? 0,
		result: spy.mock.results[i]?.value,
	}))
const recordings = () => [
	...record("Map.get", vi.mocked(HashMap.get)),
	...record("Map.has", vi.mocked(HashMap.has)),
	...record("Map.set", vi.mocked(HashMap.set)),
	...record("Map.remove", vi.mocked(HashMap.remove)),
	...record("Map.modify", vi.mocked(HashMap.modify)),
	...record("Map.modifyAt", vi.mocked(HashMap.modifyAt)),
	...record("Map.keys", vi.mocked(HashMap.keys)),
	...record("Map.values", vi.mocked(HashMap.values)),
	...record("Map.entries", vi.mocked(HashMap.entries)),
	...record("Map.toEntries", vi.mocked(HashMap.toEntries)),
	...record("Map.reduce", vi.mocked(HashMap.reduce)),
	...record("Map.map", vi.mocked(HashMap.map)),
	...record("Map.filter", vi.mocked(HashMap.filter)),
	...record("Map.forEach", vi.mocked(HashMap.forEach)),
	...record("Map.fromIterable", vi.mocked(HashMap.fromIterable)),
	...record("Set.has", vi.mocked(HashSet.has)),
	...record("Set.reduce", vi.mocked(HashSet.reduce)),
	...record("Set.some", vi.mocked(HashSet.some)),
	...record("Set.every", vi.mocked(HashSet.every)),
	...record("Set.map", vi.mocked(HashSet.map)),
	...record("Set.filter", vi.mocked(HashSet.filter)),
	...record("Set.add", vi.mocked(HashSet.add)),
	...record("Set.remove", vi.mocked(HashSet.remove)),
	...record("Set.union", vi.mocked(HashSet.union)),
	...record("Set.fromIterable", vi.mocked(HashSet.fromIterable)),
	...record("Array.fromIterable", vi.mocked(Array.fromIterable)),
]
const collections = (
	s: Core.State,
): ReadonlyArray<readonly [string, object]> => [
	...Array.flatMap(Record.toEntries(s.graph), ([key, value]) =>
		HashMap.isHashMap(value)
			? [["graph." + key, value] satisfies readonly [string, object]]
			: [],
	),
	["instances", s.instances],
	["cells", s.cells],
	["units", s.units],
	["claims", s.claims],
	["changes", s.changes],
	["active", s.active],
	["observers", s.observers],
	["commands", s.commands],
	["timers", s.timers],
	["keys", s.keys],
	["policies", s.policies],
	["preparations", s.preparations],
	["preparationKeys", s.preparationKeys],
	["verified", s.verified],
	["bindings", s.bindings],
	["consumerBindings", s.consumerBindings],
	["providerBindings", s.providerBindings],
	["routes", s.routes],
	["calls", s.calls],
	["activeCalls", s.activeCalls],
	["callsByUnit", s.callsByUnit],
	["callWaiters", s.callWaiters],
	["waitingByBinding", s.waitingByBinding],
	["callRequests", s.callRequests],
	["callSeen", s.callSeen],
	["cancelledCalls", s.cancelledCalls],
]
const object = (value: unknown): value is object =>
	typeof value === "object" && value !== null
const size = (value: unknown) =>
	HashMap.isHashMap(value)
		? HashMap.size(value)
		: HashSet.isHashSet(value)
			? HashSet.size(value)
			: 0
const writes = HashSet.make(
	"Map.set",
	"Map.remove",
	"Map.modify",
	"Map.modifyAt",
	"Map.map",
	"Map.filter",
	"Set.add",
	"Set.remove",
	"Set.union",
	"Set.map",
	"Set.filter",
)
const enumerates = HashSet.make(
	"Map.keys",
	"Map.values",
	"Map.entries",
	"Map.toEntries",
	"Map.reduce",
	"Map.map",
	"Map.filter",
	"Map.forEach",
	"Map.fromIterable",
	"Set.reduce",
	"Set.some",
	"Set.every",
	"Set.map",
	"Set.filter",
	"Set.fromIterable",
	"Array.fromIterable",
)
/** Identity labels and spy logs are probe data outside the production state. */
export const measure = <A>(state: Core.State, run: () => A): Trace<A> => {
	const labels = new WeakMap<object, string>()
	for (const [name, value] of collections(state)) labels.set(value, name)
	vi.clearAllMocks()
	const value = run()
	const operations = Array.sort(
		recordings(),
		Order.mapInput(Order.Number, (op: Operation) => op.order),
	)
	const empty: {
		readonly visits: ReadonlyArray<Visit>
		readonly scans: ReadonlyArray<string>
	} = { visits: [], scans: [] }
	const observed = Array.reduce(operations, empty, (out, op) => {
		const input = op.args[0]
		const label = object(input) ? labels.get(input) : undefined
		if (label === undefined) return out
		if (HashSet.has(writes, op.name) && object(op.result))
			labels.set(op.result, label)
		const key = op.args[1]
		return {
			visits:
				typeof key === "string"
					? Array.append(out.visits, {
							operation: op.name,
							collection: label,
							key,
						})
					: out.visits,
			scans:
				HashSet.has(enumerates, op.name) && size(input) > 0
					? Array.append(out.scans, op.name + ":" + label)
					: out.scans,
		}
	})
	return { value, ...observed }
}
