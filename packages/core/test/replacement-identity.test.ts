import { assert, describe, it } from "@effect/vitest"
import { Array, Effect, Option, Result, Stream } from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { run } from "./utils.ts"

describe("replacement identity", () => {
	it.effect.each([
		"chain",
		"reverse chain",
		"cycle",
		"divergence",
		"stale source",
	])(
		"rejects an unrepresentable %s without changing forks or aliases",
		(scenario) =>
			Effect.gen(function* () {
				const make = (name: string) =>
					Plugin.make({ name, apply: () => Effect.void })
				const p = make("P"),
					q = make("Q"),
					r = make("R")
				if (scenario === "stale source") yield* Graft.replace([[p, q]])
				const existing = yield* Graft.plugin(p)
				yield* existing.await
				const pairs: ReadonlyArray<readonly [Plugin.Plugin, Plugin.Plugin]> =
					scenario === "chain"
						? [
								[p, q],
								[q, r],
							]
						: scenario === "reverse chain"
							? [
									[q, r],
									[p, q],
								]
							: scenario === "cycle"
								? [
										[p, q],
										[q, p],
									]
								: scenario === "divergence"
									? [
											[p, q],
											[p, r],
										]
									: [[p, r]]
				const outcome = yield* Effect.result(Graft.replace(pairs))
				assert(Result.isFailure(outcome))
				assert.strictEqual(outcome.failure._tag, "ReplacementConflict")
				// Restart acknowledges any accidentally published spec, rather than racing it.
				yield* existing.restart
				yield* existing.await
				for (const plugin of [p, q, r]) {
					const fork = yield* Graft.plugin(plugin)
					yield* fork.await
				}
				const snapshot = yield* Stream.runHead(Graft.forks)
				const tree = Option.getOrThrow(snapshot)
				const first = scenario === "stale source" ? "Q" : "P"
				assert.deepStrictEqual(
					Array.map(tree, (node) => node.name),
					[first, first, "Q", "R"],
				)
			}).pipe(run),
	)

	it.effect(
		"allows convergence with an unchanged target and reuse of an old version",
		() =>
			Effect.gen(function* () {
				const p = Plugin.make({ name: "P", apply: () => Effect.void })
				const q = Plugin.make({ name: "Q", apply: () => Effect.void })
				yield* Graft.replace([
					[p, q],
					[q, q],
				])
				yield* Graft.replace([[q, p]])
				for (const plugin of [p, q]) {
					const fork = yield* Graft.plugin(plugin)
					yield* fork.await
				}
				const snapshot = yield* Stream.runHead(Graft.forks)
				const tree = Option.getOrThrow(snapshot)
				assert.deepStrictEqual(
					Array.map(tree, (node) => node.name),
					["P", "P"],
				)
			}).pipe(run),
	)

	it.effect("does not replace a distinct plugin with identical fields", () =>
		Effect.gen(function* () {
			const apply = () => Effect.void
			const first = Plugin.make({ name: "original", apply })
			const sibling = Plugin.make({ name: "original", apply })
			const replacement = Plugin.make({ name: "replacement", apply })
			const existing = yield* Graft.plugin(sibling)
			yield* existing.await
			yield* Graft.replace([[first, replacement]])
			// A restart acknowledges any replacement of this already loaded sibling.
			yield* existing.restart
			yield* existing.await
			const later = yield* Graft.plugin(sibling)
			yield* later.await
			const replaced = yield* Graft.plugin(first)
			yield* replaced.await
			const snapshot = yield* Stream.runHead(Graft.forks)
			const tree = Option.getOrThrow(snapshot)
			assert.deepStrictEqual(
				Array.map(tree, (node) => node.name),
				["original", "original", "replacement"],
			)
		}).pipe(run),
	)

	it.effect("redirects all older versions when a replacement is replaced", () =>
		Effect.gen(function* () {
			const version = (name: string) =>
				Plugin.make({ name, apply: () => Effect.void })
			const first = version("first")
			const second = version("second")
			const third = version("third")
			yield* Graft.replace([[first, second]])
			yield* Graft.replace([[second, third]])
			for (const plugin of [first, second, third]) {
				const fork = yield* Graft.plugin(plugin)
				yield* fork.await
			}
			const snapshot = yield* Stream.runHead(Graft.forks)
			const tree = Option.getOrThrow(snapshot)
			assert.deepStrictEqual(
				Array.map(tree, (node) => node.name),
				["third", "third", "third"],
			)
		}).pipe(run),
	)
})
