/**
 * Regression: `mount` publishes only the services its layer provides, not the
 * infrastructure `Layer.buildWithMemoMap` adds to the built context.
 */
import { Context, Effect, Layer, Option, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"

class First extends Context.Service<First, string>()(
	"@graftland/graft/test/mount-output.test/First",
) {}
class Second extends Context.Service<Second, string>()(
	"@graftland/graft/test/mount-output.test/Second",
) {}

it.effect("mounting two layers publishes only their own services", () =>
	Effect.gen(function* () {
		const first = yield* Graft.mount(Layer.succeed(First, "first"), {
			requires: [],
		})
		yield* first.await
		const second = yield* Graft.mount(Layer.succeed(Second, "second"), {
			requires: [],
		})
		yield* second.await
		const firstValue = yield* Graft.await(First)
		const secondValue = yield* Graft.await(Second)
		assert.strictEqual(firstValue, "first")
		assert.strictEqual(secondValue, "second")
	}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer))),
)

it.effect("does not publish the layer build's memo map", () =>
	Effect.gen(function* () {
		const mount = yield* Graft.mount(Layer.succeed(First, "first"), {
			requires: [],
		})
		yield* mount.await
		const published = yield* Graft.watch(Layer.CurrentMemoMap).pipe(
			Stream.take(1),
			Stream.runHead,
		)
		assert.deepStrictEqual(published, Option.some(Option.none()))
	}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer))),
)
