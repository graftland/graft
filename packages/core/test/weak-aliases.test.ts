import { assert, describe, it } from "@effect/vitest"
import { Array, Effect, HashMap, Option, Result, Stream } from "effect"
import * as Aliases from "../src/internal/aliases.ts"
import { Graft, Plugin } from "../src/index.ts"
import { run } from "./utils.ts"

const plugin = (name: string) => Plugin.make({ name, apply: () => Effect.void })

const expectAlias = Effect.fnUntraced(function* (
	aliases: Aliases.Aliases,
	from: Plugin.Plugin,
	to: Plugin.Plugin,
) {
	const resolved = yield* Aliases.resolve(aliases, from)
	assert.strictEqual(resolved, to)
})

describe("weak replacement identities", () => {
	it.effect(
		"matches flat aliases across deterministic replacement batches",
		() =>
			Effect.gen(function* () {
				const aliases = Aliases.make()
				const plugins = Array.makeBy(8, (index) => plugin(String(index)))
				let expected = HashMap.empty<number, number>()
				let seed = 1729
				const random = (limit: number) => {
					seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
					return (seed >>> 8) % limit
				}
				const lookup = (map: HashMap.HashMap<number, number>, key: number) =>
					Option.getOrElse(HashMap.get(map, key), () => key)
				for (let step = 0; step < 1000; step++) {
					const pairs = Array.makeBy(
						1 + random(3),
						() => [random(plugins.length), random(plugins.length)] as const,
					)
					let next = expected
					for (const [from, to] of pairs) {
						next = HashMap.map(HashMap.remove(next, to), (value) =>
							value === from ? to : value,
						)
						if (from !== to) next = HashMap.set(next, from, to)
					}
					const conflicts = Array.getSomes(
						Array.map(pairs, ([from, to], index) => {
							const overlap =
								from !== to &&
								Array.some(
									pairs,
									([other, target]) =>
										other !== target && (to === other || from === target),
								)
							return overlap ||
								lookup(next, from) !== to ||
								lookup(next, lookup(expected, from)) !== to ||
								lookup(next, to) !== to
								? Option.some(index)
								: Option.none()
						}),
					)
					const actual = yield* Effect.tx(
						Aliases.replace(
							aliases,
							Array.map(
								pairs,
								([from, to]) => [plugins[from]!, plugins[to]!] as const,
							),
						),
					)
					assert.deepStrictEqual(actual, conflicts, `Batch ${step}`)
					if (conflicts.length === 0) expected = next
					for (let index = 0; index < plugins.length; index++) {
						const resolved = yield* Effect.tx(
							Aliases.resolve(aliases, plugins[index]!),
						)
						assert.strictEqual(
							resolved,
							plugins[lookup(expected, index)],
							`Identity ${index} after batch ${step}`,
						)
					}
				}
			}),
	)

	it.effect("rolls back identities created by a failed outer transaction", () =>
		Effect.gen(function* () {
			const aliases = Aliases.make()
			const p = plugin("P")
			const q = plugin("Q")
			const r = plugin("R")
			yield* Effect.tx(Aliases.replace(aliases, [[p, q]]))
			const outcome = yield* Effect.result(
				Effect.tx(
					Effect.gen(function* () {
						yield* Aliases.replace(aliases, [[q, r]])
						yield* expectAlias(aliases, p, r)
						return yield* Effect.fail("rollback")
					}),
				),
			)
			assert(Result.isFailure(outcome))
			yield* expectAlias(aliases, p, q)
			yield* expectAlias(aliases, q, q)
			yield* expectAlias(aliases, r, r)
		}),
	)

	it.effect(
		"does not write a rejected plan inside a successful outer transaction",
		() =>
			Effect.gen(function* () {
				const aliases = Aliases.make()
				const p = plugin("P")
				const q = plugin("Q")
				const r = plugin("R")
				yield* Effect.tx(
					Effect.gen(function* () {
						yield* Aliases.replace(aliases, [[p, q]])
						const rejected = yield* Aliases.replace(aliases, [[p, r]])
						assert.deepStrictEqual(rejected, [0])
						yield* expectAlias(aliases, p, q)
					}),
				)
				yield* expectAlias(aliases, p, q)
				yield* expectAlias(aliases, r, r)
			}),
	)

	it.effect(
		"detaches an old target without redirecting its former family",
		() =>
			Effect.gen(function* () {
				const aliases = Aliases.make()
				const p = plugin("P")
				const q = plugin("Q")
				const a = plugin("A")
				const b = plugin("B")
				yield* Effect.tx(
					Aliases.replace(aliases, [
						[p, q],
						[a, b],
					]),
				)
				yield* Effect.tx(Aliases.replace(aliases, [[q, a]]))
				yield* expectAlias(aliases, p, a)
				yield* expectAlias(aliases, q, a)
				yield* expectAlias(aliases, a, a)
				yield* expectAlias(aliases, b, b)
				yield* Effect.tx(Aliases.replace(aliases, [[a, p]]))
				yield* expectAlias(aliases, q, p)
				yield* expectAlias(aliases, b, b)
			}),
	)
	it.effect(
		"rolls back replacement aliases and live fork specifications together",
		() =>
			Effect.gen(function* () {
				const p = plugin("P")
				const q = plugin("Q")
				const existing = yield* Graft.plugin(p)
				yield* existing.await
				const outcome = yield* Effect.result(
					Effect.tx(
						Effect.gen(function* () {
							yield* Graft.replace([[p, q]])
							return yield* Effect.fail("rollback")
						}),
					),
				)
				assert(Result.isFailure(outcome))
				yield* existing.restart
				yield* existing.await
				const later = yield* Graft.plugin(p)
				yield* later.await
				const snapshot = yield* Stream.runHead(Graft.forks)
				assert.deepStrictEqual(
					Array.map(Option.getOrThrow(snapshot), (entry) => entry.name),
					["P", "P"],
				)
			}).pipe(run),
	)
})
