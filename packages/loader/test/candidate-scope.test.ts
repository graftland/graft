import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Path,
	Ref,
	Scope,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Plugin } from "@graftland/graft"

import { ModuleResolver } from "../src/index.ts"

const missing = Object.assign(
	new Error("Cannot find package 'demo' imported from /app/index.js"),
	{ code: "ERR_MODULE_NOT_FOUND" },
)
const plugin = Plugin.make({ name: "fallback", apply: () => Effect.void })

it.effect(
	"releases missing candidates before fallback and retains the successful lease",
	() =>
		Effect.gen(function* () {
			const events = yield* Ref.make<ReadonlyArray<string>>([])
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: (name) =>
					Effect.gen(function* () {
						yield* Effect.acquireRelease(
							Ref.update(events, Array.append(`acquire ${name}`)),
							() => Ref.update(events, Array.append(`release ${name}`)),
						)
						if (name === "demo") return yield* Effect.fail(missing)
						return { default: plugin }
					}),
			})
			yield* Effect.gen(function* () {
				const resolved = yield* resolver.resolve("demo")
				assert.strictEqual(resolved, plugin)
				const recorded = yield* Ref.get(events)
				assert.deepStrictEqual(recorded, [
					"acquire demo",
					"release demo",
					"acquire @graftland/plugin-demo",
				])
			}).pipe(Effect.scoped)
			const recorded = yield* Ref.get(events)
			assert.deepStrictEqual(recorded, [
				"acquire demo",
				"release demo",
				"acquire @graftland/plugin-demo",
				"release @graftland/plugin-demo",
			])
		}).pipe(Effect.provide(Path.layer)),
)

it.effect(
	"combines candidate failure and cleanup before deciding whether to fall back",
	() =>
		Effect.gen(function* () {
			const attempted = yield* Ref.make<ReadonlyArray<string>>([])
			const released = yield* Ref.make(0)
			const cleanup = new Error("Candidate cleanup failed")
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: (name) =>
					Ref.update(attempted, Array.append(name)).pipe(
						Effect.andThen(
							name === "demo"
								? Effect.acquireRelease(Effect.void, () =>
										Ref.update(released, (count) => count + 1).pipe(
											Effect.andThen(Effect.die(cleanup)),
										),
									).pipe(Effect.andThen(Effect.fail(missing)))
								: Effect.succeed({ default: plugin }),
						),
					),
			})
			const parent = yield* Effect.scope
			const owner = yield* Scope.fork(parent)
			const result = yield* resolver
				.resolve("demo")
				.pipe(Scope.provide(owner), Effect.exit)
			assert(Exit.isFailure(result))
			assert.strictEqual(result.cause.reasons.length, 2)
			assert(
				Array.some(
					result.cause.reasons,
					(reason) =>
						Cause.isFailReason(reason) && reason.error.cause === missing,
				),
			)
			assert(
				Array.some(
					result.cause.reasons,
					(reason) => Cause.isDieReason(reason) && reason.defect === cleanup,
				),
			)
			const tried = yield* Ref.get(attempted)
			assert.deepStrictEqual(tried, ["demo"])
			yield* Scope.close(owner, Exit.void)
			const count = yield* Ref.get(released)
			assert.strictEqual(
				count,
				1,
				"Failed scopes must detach from their parent",
			)
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)

it.effect(
	"releases a candidate with an invalid export before returning its error",
	() =>
		Effect.gen(function* () {
			const released = yield* Ref.make(false)
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: () =>
					Effect.acquireRelease(
						Effect.succeed({ default: "not a plugin" }),
						() => Ref.set(released, true),
					),
			})
			const result = yield* Effect.exit(resolver.resolve("demo"))
			assert(Exit.isFailure(result))
			const didRelease = yield* Ref.get(released)
			assert.isTrue(didRelease)
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)

it.effect(
	"cancellation releases the current candidate while its parent stays open",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const released = yield* Ref.make(false)
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: () =>
					Effect.acquireRelease(Deferred.succeed(entered, undefined), () =>
						Ref.set(released, true),
					).pipe(Effect.andThen(Effect.never)),
			})
			const resolving = yield* Effect.forkScoped(resolver.resolve("demo"))
			yield* Deferred.await(entered)
			yield* Fiber.interrupt(resolving)
			const didRelease = yield* Ref.get(released)
			assert.isTrue(didRelease)
		}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)
