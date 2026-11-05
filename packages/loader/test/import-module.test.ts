import { Effect, Path, Ref, Scope } from "effect"
import { assert, it } from "@effect/vitest"

import { ModuleResolver } from "../src/index"

it.effect("imports an exact non-plugin module with a caller-owned lease", () =>
	Effect.gen(function* () {
		const leases = yield* Ref.make(0)
		const resolver = yield* ModuleResolver.make({
			base: "/app",
			importer: (specifier, options) => {
				assert.equal(specifier, "file:///app/contract.js")
				return Effect.acquireRelease(
					Ref.update(leases, (n) => n + 1),
					() => Ref.update(leases, (n) => n - 1),
				).pipe(
					Effect.as({ answer: 42 }),
					Scope.provide(options.observationScope),
				)
			},
		})
		yield* Effect.gen(function* () {
			const module = yield* resolver.importModule("./contract.js")
			assert.deepEqual(module, { answer: 42 })
			const acquired = yield* Ref.get(leases)
			assert.equal(acquired, 1)
		}).pipe(Effect.scoped)
		const released = yield* Ref.get(leases)
		assert.equal(released, 0)
	}).pipe(Effect.provide(Path.layer)),
)
