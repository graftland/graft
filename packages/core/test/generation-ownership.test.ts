import { Context, Effect, HashMap, HashSet, Option, TxRef } from "effect"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { withdraw } from "../src/internal/activation.ts"
import { publicationCycle } from "../src/internal/dependencies.ts"
import * as Generations from "../src/internal/generations.ts"
import {
	realmKey,
	type Activation,
	type GraphNode,
	type Provision,
	type Slot,
} from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { run } from "./utils.ts"

const node = (id: number, parent?: GraphNode): GraphNode => ({
	id,
	parent,
	state: TxRef.makeUnsafe<GraphNode["state"]["value"]>({
		live: true,
		resolutions: HashMap.empty(),
	}),
})

it.effect(
	"keeps two generations leased to the same provider and settles each exactly once",
	() =>
		run(
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const provider = node(1)
				const consumer = node(2)
				const slot: Slot = {
					key: "provider",
					provision: TxRef.makeUnsafe(Option.none()),
					holders: TxRef.makeUnsafe(1),
				}
				const provision: Provision = {
					realm: "",
					key: slot.key,
					service: slot.key,
					value: undefined,
					owner: provider.id,
					generation: new Generations.Token({
						fork: provider.id,
						generation: 0,
					}),
					node: provider,
					slot,
					consumers: TxRef.makeUnsafe(HashSet.empty()),
				}
				const resolution = {
					watch: HashMap.empty(),
					provisions: [provision, provision],
				}
				const old = yield* Effect.tx(
					Generations.acquire(runtime, consumer, resolution),
				)
				const next = yield* Effect.tx(
					Generations.acquire(runtime, consumer, resolution),
				)
				const both = yield* TxRef.get(provision.consumers)
				assert.strictEqual(HashSet.size(both), 2)
				yield* Effect.tx(Generations.settle(runtime, consumer, old))
				yield* Effect.tx(Generations.settle(runtime, consumer, old))
				const holders = yield* TxRef.get(provision.consumers)
				assert.strictEqual(HashSet.size(holders), 1)
				assert.isTrue(HashSet.has(holders, next))
				const state = yield* TxRef.get(consumer.state)
				assert.isTrue(HashMap.has(state.resolutions, next))
				yield* Effect.tx(Generations.settle(runtime, consumer, next))
				const empty = yield* TxRef.get(provision.consumers)
				assert.strictEqual(HashSet.size(empty), 0)
			}),
		),
)

class Value extends Context.Service<Value, string>()(
	"@graftland/graft/test/generation-ownership.test/Value",
) {}

it.effect(
	"keeps a new publication and its slot retain count after repeated old teardown",
	() =>
		run(
			Effect.gen(function* () {
				const { runtime, activation: root } = yield* RuntimeContext
				const logical = node(1)
				const make = Effect.gen(function* () {
					const generation = yield* Effect.tx(
						Generations.acquire(runtime, logical, {
							watch: HashMap.empty(),
							provisions: [],
						}),
					)
					const activation: Activation = {
						...root,
						node: logical,
						fork: logical.id,
						generation,
						published: yield* TxRef.make(
							Option.some<ReadonlyArray<Provision>>([]),
						),
					}
					return activation
				})
				const old = yield* make
				yield* Graft.provide(Value, "old").pipe(
					Effect.provideService(RuntimeContext, { runtime, activation: old }),
				)
				yield* withdraw(runtime, old)
				yield* Effect.tx(Generations.settle(runtime, logical, old.generation))
				const next = yield* make
				yield* Graft.provide(Value, "next").pipe(
					Effect.provideService(RuntimeContext, { runtime, activation: next }),
				)
				const directory = yield* TxRef.get(runtime.slots)
				const slot = HashMap.getUnsafe(directory, realmKey("", Value.key))
				const retain = yield* TxRef.get(slot.holders)
				yield* withdraw(runtime, old)
				yield* Effect.tx(Generations.settle(runtime, logical, old.generation))
				const current = yield* TxRef.get(slot.provision)
				assert.strictEqual(Option.getOrThrow(current).value, "next")
				const retained = yield* TxRef.get(slot.holders)
				assert.strictEqual(retained, retain)
				yield* withdraw(runtime, next)
				yield* Effect.tx(Generations.settle(runtime, logical, next.generation))
			}),
		),
)

it.effect(
	"checks withdrawn generations and parent ownership when detecting publication cycles",
	() =>
		run(
			Effect.gen(function* () {
				const { runtime } = yield* RuntimeContext
				const parent = node(1)
				const child = node(2, parent)
				const watched: Slot = {
					key: "watched",
					provision: TxRef.makeUnsafe(Option.none()),
					holders: TxRef.makeUnsafe(1),
				}
				const old = yield* Effect.tx(
					Generations.acquire(runtime, parent, {
						watch: HashMap.make([watched.key, watched]),
						provisions: [],
					}),
				)
				const next = yield* Effect.tx(
					Generations.acquire(runtime, parent, {
						watch: HashMap.empty(),
						provisions: [],
					}),
				)
				const before = yield* Effect.tx(publicationCycle(child, watched.key))
				assert.isTrue(before)
				yield* Effect.tx(Generations.settle(runtime, parent, next))
				const retained = yield* Effect.tx(publicationCycle(child, watched.key))
				assert.isTrue(retained)
				yield* Effect.tx(Generations.settle(runtime, parent, old))
				const settled = yield* Effect.tx(publicationCycle(child, watched.key))
				assert.isFalse(settled)
			}),
		),
)
