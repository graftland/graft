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
const missingPackage = (name: string) =>
	Object.assign(
		new Error(`Cannot find package '${name}' imported from /app/index.js`),
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
						if (name === "demo" || name === "graft-plugin-demo")
							return yield* Effect.fail(missingPackage(name))
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
					"acquire graft-plugin-demo",
					"release graft-plugin-demo",
				])
			}).pipe(Effect.scoped)
			const recorded = yield* Ref.get(events)
			assert.deepStrictEqual(recorded, [
				"acquire demo",
				"release demo",
				"acquire @graftland/plugin-demo",
				"acquire graft-plugin-demo",
				"release graft-plugin-demo",
				"release @graftland/plugin-demo",
			])
		}).pipe(Effect.provide(Path.layer)),
)

it.effect("resolves a short name to a third-party package alone", () =>
	Effect.gen(function* () {
		const resolver = yield* ModuleResolver.make({
			base: "/app",
			importer: (name) =>
				name === "graft-plugin-demo"
					? Effect.succeed({ default: plugin })
					: Effect.fail(missingPackage(name)),
		})
		const resolved = yield* resolver.resolve("demo")
		assert.strictEqual(resolved, plugin)
	}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)

it.effect("fails when a short name matches packages of both conventions", () =>
	Effect.gen(function* () {
		const resolver = yield* ModuleResolver.make({
			base: "/app",
			importer: (name) =>
				name === "demo"
					? Effect.fail(missingPackage(name))
					: Effect.succeed({ default: plugin }),
		})
		const error = yield* Effect.flip(resolver.resolve("demo"))
		assert.strictEqual(error._tag, "AmbiguousPluginName")
		assert.deepStrictEqual(
			error._tag === "AmbiguousPluginName" ? error.packages : [],
			["@graftland/plugin-demo", "graft-plugin-demo"],
		)
	}).pipe(Effect.scoped, Effect.provide(Path.layer)),
)

it.effect("prefers the name as written over both conventions", () =>
	Effect.gen(function* () {
		const resolver = yield* ModuleResolver.make({
			base: "/app",
			importer: () => Effect.succeed({ default: plugin }),
		})
		const resolved = yield* resolver.resolve("demo")
		assert.strictEqual(resolved, plugin)
	}).pipe(Effect.scoped, Effect.provide(Path.layer)),
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

it.effect("skips a short name as written that imports but is no plugin", () =>
	Effect.gen(function* () {
		// `http` stands for a Node builtin: it imports, but exports no plugin.
		const resolver = yield* ModuleResolver.make({
			base: "/app",
			importer: (name) =>
				name === "http"
					? Effect.succeed({ createServer: () => undefined })
					: name === "@graftland/plugin-http"
						? Effect.succeed({ default: plugin })
						: Effect.fail(missingPackage(name)),
		})
		const resolved = yield* resolver.resolve("http").pipe(Effect.scoped)
		assert.strictEqual(resolved, plugin)
	}).pipe(Effect.provide(Path.layer)),
)

it.effect(
	"reports a short name as written that is no plugin when nothing else matches",
	() =>
		Effect.gen(function* () {
			const resolver = yield* ModuleResolver.make({
				base: "/app",
				importer: (name) =>
					name === "events"
						? Effect.succeed({ EventEmitter: class {} })
						: Effect.fail(missingPackage(name)),
			})
			const exit = yield* resolver
				.resolve("events")
				.pipe(Effect.scoped, Effect.exit)
			assert.isTrue(Exit.isFailure(exit))
			const error = Exit.isFailure(exit)
				? Cause.findErrorOption(exit.cause)
				: undefined
			assert.strictEqual(
				error?._tag === "Some" ? error.value._tag : undefined,
				"ModuleInvalid",
			)
		}).pipe(Effect.provide(Path.layer)),
)
