/**
 * Compile-time contracts of the public API. Every `@ts-expect-error` marks a
 * program that must not typecheck; the runtime test at the end only makes sure
 * vitest executes this file.
 */
import { Context, Effect, Layer, Scope, type Fiber } from "effect"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"

class Config extends Context.Service<Config, { readonly region: string }>()(
	"@graftland/graft/test/mount-types.test/Config",
) {}
class Cache extends Context.Service<Cache, { readonly name: string }>()(
	"@graftland/graft/test/mount-types.test/Cache",
) {}
class Marker extends Context.Service<Marker, { readonly id: number }>()(
	"@graftland/graft/test/mount-types.test/Marker",
) {}

/** Requires `Config`. */
const derived = Layer.effect(Marker, Effect.as(Config, { id: 1 }))
/** Requires `Cache`. */
const cached = Layer.effect(Marker, Effect.as(Cache, { id: 2 }))
/** Requires both. */
const both = Layer.effect(
	Marker,
	Effect.as(Effect.andThen(Config, Cache), { id: 3 }),
)

// `use` keeps the caller's errors and adds `ServiceWithdrawn`.
const used = Graft.use(Config, (config) => Effect.succeed(config.region))
const withdrawalIsTyped = (
	error: Effect.Error<typeof used>,
): Graft.ServiceWithdrawn => error

// A caller error survives next to `ServiceWithdrawn`.
const failing = Graft.use(Config, () =>
	Effect.fail(Graft.ServiceConflict.make({ service: "x" })),
)
const unionIncludesWithdrawal = (
	error: Effect.Error<typeof failing>,
): Graft.ServiceWithdrawn | Graft.ServiceConflict => error

/** Never run; its body only has to typecheck. */
const contracts: Effect.Effect<void, never, Graft.Graft | Scope.Scope> =
	Effect.gen(function* () {
		// `requires` covers the layer's requirements.
		const covered = yield* Graft.mount(derived, { requires: [Config] })

		// A layer's optional dependencies are read with `Effect.serviceOption`, so
		// they stay out of its RIn and required entries cover it alone.
		const mixed = yield* Graft.mount(derived, {
			requires: [Config, Graft.optional(Cache)],
		})
		const bothCovered = yield* Graft.mount(both, {
			requires: [Config, Cache],
		})

		// @ts-expect-error - optional entries do not cover RIn: Cache may be absent
		// @effect-diagnostics-next-line missingLayerContext:off -- this line asserts the type error below
		const optionalOnly = yield* Graft.mount(cached, {
			requires: [Graft.optional(Cache)],
		})

		// @ts-expect-error - `requires` must cover the layer's RIn: Config is not declared
		// @effect-diagnostics-next-line missingLayerContext:off -- this line asserts the type error below
		const missing = yield* Graft.mount(derived)

		// @ts-expect-error - `requires` must cover every RIn entry: Cache is not declared
		// @effect-diagnostics-next-line missingLayerContext:off -- this line asserts the type error below
		const partial = yield* Graft.mount(both, { requires: [Config] })

		// Background fibers belong to a mount: `Graft.fork` needs `Tasks` next to
		// the graph, which only a mounted layer's environment has.
		const forked = Graft.fork(Effect.void)
		const forkNeedsTasks: Effect.Effect<
			Fiber.Fiber<void>,
			never,
			Graft.Graft | Graft.Tasks<never>
		> = forked
		// @ts-expect-error - without `Tasks` in the expected context, `Graft.fork` does not fit
		// @effect-diagnostics-next-line missingEffectContext:off -- this line asserts the type error below
		const forkWithoutTasks: Effect.Effect<
			Fiber.Fiber<void>,
			never,
			Graft.Graft
		> = forked

		yield* Effect.sync(
			() =>
				[
					covered,
					optionalOnly,
					bothCovered,
					mixed,
					missing,
					partial,
					forkNeedsTasks,
					forkWithoutTasks,
				].length,
		)
	})

it.effect("the public mount contract compiles and mounts a layer", () =>
	Effect.gen(function* () {
		const layer = Layer.succeed(Config, { region: "eu" })
		const mount = yield* Graft.mount(layer, { requires: [] })
		yield* mount.await
		const config = yield* Graft.await(Config)
		assert.strictEqual(config.region, "eu")
		// Referencing the type contracts keeps them from being reported as unused.
		assert.isDefined([
			contracts,
			used,
			withdrawalIsTyped,
			failing,
			unionIncludesWithdrawal,
		])
	}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer))),
)
