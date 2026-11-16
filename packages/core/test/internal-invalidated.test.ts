/**
 * The graph rejects a publication from an activation that another publication
 * invalidated inside the same transaction. This is internal-level coverage:
 * the public API cannot reach an activation directly.
 */
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { publishValue } from "../src/internal/publication.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"

const namespace = "@graftland/graft/test/internal-invalidated.test"

class First extends Context.Service<First, string>()(`${namespace}/First`) {}
class Target extends Context.Service<Target, string>()(`${namespace}/Target`) {}
/** The mounts publish `First` and `Target` themselves, so their layers output
 * markers that cannot collide with those publications. */
class LeftMarker extends Context.Service<LeftMarker, null>()(
	`${namespace}/LeftMarker`,
) {}
class RightMarker extends Context.Service<RightMarker, null>()(
	`${namespace}/RightMarker`,
) {}

it.effect(
	"rejects a publication from an activation invalidated in the same transaction",
	() =>
		Effect.gen(function* () {
			const publishLeft =
				yield* Deferred.make<Effect.Effect<void, Graft.ServiceConflict>>()
			const publishRight =
				yield* Deferred.make<Effect.Effect<void, Graft.ServiceConflict>>()

			/** Captures its activation and publishes `Target` on demand. */
			const left = Layer.effect(
				LeftMarker,
				Effect.gen(function* () {
					const context = yield* Effect.context<RuntimeContext>()
					yield* Deferred.succeed(
						publishLeft,
						publishValue(Target.key, "left").pipe(
							Effect.provideContext(context),
						),
					)
					return null
				}),
			)
			/** Captures its activation and publishes `First` on demand. */
			const right = Layer.effect(
				RightMarker,
				Effect.gen(function* () {
					const context = yield* Effect.context<RuntimeContext>()
					yield* Deferred.succeed(
						publishRight,
						publishValue(First.key, "right").pipe(
							Effect.provideContext(context),
						),
					)
					return null
				}),
			)

			// Both mounts watch the other's service, so one publication invalidates
			// the other's resolution before its supervisor runs.
			const leftMount = yield* Graft.mount(left, {
				name: "left",
				requires: [Graft.optional(First)],
			})
			const rightMount = yield* Graft.mount(right, {
				name: "right",
				requires: [Graft.optional(Target)],
			})
			yield* leftMount.await
			yield* rightMount.await

			const publishTarget = yield* Deferred.await(publishLeft)
			const publishFirst = yield* Deferred.await(publishRight)
			// The transaction exposes the first publication to the second check
			// before either supervisor runs.
			const result = yield* Effect.exit(
				Effect.tx(Effect.andThen(publishTarget, publishFirst)),
			)

			assert.isTrue(Exit.isFailure(result))
			if (Exit.isFailure(result)) {
				const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
				assert.strictEqual(error.reason, "Invalidated")
			}
			// The failed transaction published nothing.
			const published = yield* Graft.watch(Target).pipe(
				Stream.take(1),
				Stream.runHead,
			)
			assert.deepStrictEqual(published, Option.some(Option.none()))
		}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer))),
)
