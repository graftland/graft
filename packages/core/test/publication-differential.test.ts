import {
	Array,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	Option,
	Result,
	TxRef,
} from "effect"
import { assert, it } from "@effect/vitest"

import { publicationCycle } from "../src/internal/dependencies.ts"
import {
	realmKey,
	type ActiveResolution,
	type GraphNode,
	type Provision,
	type ServiceKey,
	type Slot,
} from "../src/internal/runtime.ts"

/** The former forward fixed-point algorithm, retained as an independent oracle. */
const forward = (
	nodes: ReadonlyArray<GraphNode>,
	active: HashMap.HashMap<number, ActiveResolution>,
	key: ServiceKey,
	publisher: number,
): boolean => {
	let affected = HashSet.fromIterable(
		Array.filterMap(HashMap.toEntries(active), ([id, resolution]) =>
			HashMap.has(resolution.watch, key)
				? Result.succeed(id)
				: Result.fail(undefined),
		),
	)
	while (true) {
		const next = Array.reduce(nodes, affected, (result, node) => {
			const inherited =
				node.parent !== undefined && HashSet.has(result, node.parent.id)
			const consumes = Option.exists(
				HashMap.get(active, node.id),
				(resolution) =>
					Array.some(resolution.provisions, (provision) =>
						HashSet.has(result, provision.owner),
					),
			)
			return inherited || consumes ? HashSet.add(result, node.id) : result
		})
		if (HashSet.size(next) === HashSet.size(affected))
			return HashSet.has(next, publisher)
		affected = next
	}
}

it.effect(
	"matches the forward fixed point on seeded small graphs and candidate overrides",
	() =>
		Effect.gen(function* () {
			let seed = 0x51a7
			const random = (limit: number): number => {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
				return (seed >>> 16) % limit
			}
			const slots = Array.makeBy(3, (index): Slot => ({
				key: realmKey(`realm:${index % 2}`, `service:${index}`),
				provision: TxRef.makeUnsafe<Option.Option<Provision>>(Option.none()),
				holders: TxRef.makeUnsafe(1),
			}))
			for (let trial = 0; trial < 500; trial++) {
				let nodes: ReadonlyArray<GraphNode> = []
				const size = random(8) + 1
				for (let id = 0; id < size; id++) {
					const parent =
						id > 0 && random(3) === 0 ? nodes[random(id)] : undefined
					nodes = Array.append(nodes, {
						id,
						parent,
						state: TxRef.makeUnsafe<GraphNode["state"]["value"]>({
							live: true,
							resolution: undefined,
						}),
					})
				}
				const resolution = (): ActiveResolution => ({
					watch: HashMap.fromIterable(
						Array.map(
							Array.filter(slots, () => random(3) === 0),
							(slot) => [slot.key, slot] as const,
						),
					),
					provisions: Array.map(
						Array.filter(nodes, () => random(4) === 0),
						(node): Provision => ({
							key: slots[0]!.key,
							service: "dependency",
							value: undefined,
							owner: node.id,
							node,
							slot: slots[0]!,
							consumers: TxRef.makeUnsafe(HashSet.empty<number>()),
						}),
					),
				})
				let active = HashMap.empty<number, ActiveResolution>()
				for (const node of nodes) {
					if (random(4) !== 0) {
						const current = resolution()
						active = HashMap.set(active, node.id, current)
						yield* TxRef.set(node.state, { live: true, resolution: current })
					}
				}
				for (const publisher of nodes) {
					const candidate = resolution()
					for (const slot of slots) {
						const actual = yield* Effect.tx(
							publicationCycle(publisher, slot.key),
						)
						assert.strictEqual(
							actual,
							forward(nodes, active, slot.key, publisher.id),
							`trial ${trial}, publisher ${publisher.id}`,
						)
						const retried = yield* Effect.tx(
							publicationCycle(publisher, slot.key, candidate),
						)
						assert.strictEqual(
							retried,
							forward(
								nodes,
								HashMap.set(active, publisher.id, candidate),
								slot.key,
								publisher.id,
							),
							`candidate ${trial}, publisher ${publisher.id}`,
						)
					}
				}
			}
		}),
)

it.effect(
	"waits only on reverse-reachable nodes and keeps lease edges through withdrawal",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const makeNode = (id: number, parent?: GraphNode): GraphNode => ({
					id,
					parent,
					state: TxRef.makeUnsafe<GraphNode["state"]["value"]>({
						live: true,
						resolution: undefined,
					}),
				})
				const watcher = makeNode(1)
				const bridge = makeNode(2)
				const publisher = makeNode(3, bridge)
				const unrelated = makeNode(4)
				const slot: Slot = {
					key: realmKey("", "target"),
					provision: TxRef.makeUnsafe(Option.none()),
					holders: TxRef.makeUnsafe(1),
				}
				const lease: Provision = {
					key: slot.key,
					service: "lease",
					value: undefined,
					owner: watcher.id,
					node: watcher,
					slot,
					consumers: TxRef.makeUnsafe(HashSet.empty<number>()),
				}
				yield* TxRef.set(watcher.state, {
					live: true,
					resolution: { watch: HashMap.make([slot.key, slot]), provisions: [] },
				})
				yield* TxRef.set(bridge.state, {
					live: true,
					resolution: { watch: HashMap.empty(), provisions: [lease] },
				})
				const waiting = yield* Effect.forkScoped(
					Effect.tx(
						Effect.gen(function* () {
							if (yield* publicationCycle(publisher, slot.key))
								return yield* Effect.txRetry
						}),
					),
				)
				while (watcher.state.pending.size === 0) yield* Effect.yieldNow
				assert.isAbove(bridge.state.pending.size, 0)
				assert.isAbove(publisher.state.pending.size, 0)
				assert.strictEqual(unrelated.state.pending.size, 0)
				const subscribers = [...watcher.state.pending.keys()]
				yield* TxRef.set(unrelated.state, {
					live: false,
					resolution: undefined,
				})
				assert.deepStrictEqual([...watcher.state.pending.keys()], subscribers)
				// Withdrawal clears watch only. The lease keeps the bridge connected to the watcher.
				yield* TxRef.update(bridge.state, (state) => ({
					...state,
					resolution: { watch: HashMap.empty(), provisions: [lease] },
				}))
				const withdrawn = yield* Effect.tx(
					publicationCycle(publisher, slot.key),
				)
				assert.isTrue(withdrawn)
				// Lease release removes the reverse path and wakes the failed publisher.
				yield* TxRef.set(bridge.state, { live: true, resolution: undefined })
				yield* Fiber.join(waiting)
			}),
		),
)
