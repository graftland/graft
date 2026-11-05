import {
	Array,
	Cause,
	Effect,
	Layer,
	Option,
	Predicate,
	Ref,
	Scope,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Loader, ModuleResolver } from "../src/index.ts"
import { loaderService } from "./utils.ts"

const defects = (cause: Cause.Cause<unknown>): ReadonlyArray<unknown> =>
	Array.flatMap(cause.reasons, (reason): ReadonlyArray<unknown> => {
		const value = Cause.isDieReason(reason)
			? reason.defect
			: Cause.isFailReason(reason)
				? reason.error
				: undefined
		if (Predicate.hasProperty(value, "cause") && Cause.isCause(value.cause))
			return defects(value.cause)
		return Cause.isDieReason(reason) ? [value] : []
	})

it.effect.each([
	{ operation: "remove", lifecycleFails: false },
	{ operation: "remove", lifecycleFails: true },
	{ operation: "disable", lifecycleFails: true },
	{ operation: "replace", lifecycleFails: true },
])(
	"isolates cleanup during $operation with lifecycle failure $lifecycleFails",
	({ operation, lifecycleFails }) =>
		Effect.gen(function* () {
			const events = yield* Ref.make<ReadonlyArray<string>>([])
			const record = (event: string) => Ref.update(events, Array.append(event))
			const lifecycleFailure = new Error("Lifecycle cleanup failed")
			const observationFailure = new Error("Observation cleanup failed")
			const leaf = (name: string) =>
				Plugin.make({
					name,
					apply: () =>
						Effect.acquireRelease(record(`start ${name}`), () =>
							record(`stop ${name}`).pipe(
								Effect.andThen(
									name === "bad" && lifecycleFails
										? Effect.die(lifecycleFailure)
										: Effect.void,
								),
							),
						),
				})
			const bad = leaf("bad")
			const healthy = leaf("healthy")
			const resolver = Layer.succeed(ModuleResolver.ModuleResolver, {
				importModule: (specifier) =>
					Effect.fail(
						ModuleResolver.ModuleInvalid.make({
							specifier,
							cause: "Unused in this fixture",
						}),
					),
				resolve: (name, options) =>
					Effect.gen(function* () {
						if (name === "bad" && options !== undefined) {
							yield* Effect.addFinalizer(() =>
								record("release observation").pipe(
									Effect.andThen(Effect.die(observationFailure)),
								),
							).pipe(Scope.provide(options.observationScope))
						}
						return name === "bad" ? bad : healthy
					}),
			})
			yield* Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [
					{ id: "bad", name: "bad" },
					{ id: "healthy", name: "healthy" },
				])
				const loader = yield* loaderService
				yield* loader.ready
				if (operation === "remove") yield* loader.remove("bad")
				else if (operation === "disable")
					yield* loader.update("bad", { disabled: true })
				else yield* loader.update("bad", { name: "healthy" })
				yield* loader.ready
				const observed = yield* Ref.get(events)
				const expected = [
					"start bad",
					"start healthy",
					"stop bad",
					"release observation",
				]
				assert.deepStrictEqual(
					observed,
					operation === "replace" ? [...expected, "start healthy"] : expected,
				)
				const log = yield* Graft.logs.pipe(
					Stream.filter(
						(entry) =>
							Array.isArray(entry.message) &&
							Array.contains(entry.message, "Disposing a loader entry failed"),
					),
					Stream.runHead,
					Effect.map(Option.getOrThrow),
				)
				assert.sameMembers(
					[...defects(log.cause)],
					lifecycleFails
						? [lifecycleFailure, observationFailure]
						: [observationFailure],
				)
				assert.strictEqual(log.annotations["loader.entry"], "bad")
				const state = yield* Stream.runHead(loader.root.state)
				assert.strictEqual(Option.getOrThrow(state)._tag, "Active")
				yield* loader.create({ id: "later", name: "healthy" })
				yield* loader.ready
				const later = yield* Ref.get(events)
				assert.deepStrictEqual(later, [...observed, "start healthy"])
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, resolver)),
			)
		}),
)
