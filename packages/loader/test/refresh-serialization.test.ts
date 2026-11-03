import { assert, it } from "@effect/vitest"
import { Graft, Plugin } from "@graftland/graft"
import {
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Ref,
	Schema,
	Stream,
	Array,
} from "effect"
import { TestClock } from "effect/testing"
import { Entry, Intercept, Loader, ModuleResolver } from "../src/index.ts"
import { loaderService } from "./utils.ts"

class Gate extends Context.Service<Gate, string>()(
	"@graftland/loader/test/refresh-serialization.test/Gate",
) {}

it.effect.each(["direct", "nested", "injected", "injected group"])(
	"serializes a refresh and a newer target through a %s entry",
	(kind) =>
		Effect.gen(function* () {
			const resolving = yield* Deferred.make<void>()
			const releaseImport = yield* Deferred.make<void>()
			const refreshing = yield* Deferred.make<void>()
			const releaseRead = yield* Deferred.make<void>()
			const updating = yield* Deferred.make<void>()
			const releaseUpdate = yield* Deferred.make<void>()
			const cancelled = yield* Deferred.make<void>()
			const laterStarted = yield* Deferred.make<void>()
			const changed = yield* Ref.make(false)
			const journal = yield* Ref.make<ReadonlyArray<string>>([])
			const record = (s: string) => Ref.update(journal, Array.append(s))
			const setting = Context.Reference("refresh-serialization/Setting", {
				defaultValue: () => "default",
			})
			const leaf = Plugin.make({
				name: "leaf",
				config: Schema.String,
				apply: (value) =>
					Effect.gen(function* () {
						yield* record(`start ${value}`)
						if (value === "c") yield* Deferred.succeed(laterStarted, undefined)
						return (value: string) =>
							Effect.gen(function* () {
								yield* record(`begin ${value}`)
								if (value === "b") {
									yield* Deferred.succeed(updating, undefined)
									yield* Deferred.await(releaseUpdate).pipe(
										Effect.onInterrupt(() =>
											Deferred.succeed(cancelled, undefined),
										),
									)
								}
								if (value === "c")
									yield* Deferred.succeed(laterStarted, undefined)
								yield* record(`end ${value}`)
								return true
							})
					}),
			})
			const environment = Layer.mergeAll(
				ModuleResolver.fromRecord({ leaf }),
				Intercept.layer([
					{
						key: setting.key,
						schema: Schema.String,
						resolve: () =>
							Deferred.succeed(resolving, undefined).pipe(
								Effect.andThen(Deferred.await(releaseImport)),
								Effect.as(Graft.intercept(setting, () => "value")),
							),
					},
				]),
				ConfigProvider.layer(
					ConfigProvider.make(() =>
						Effect.gen(function* () {
							if (!(yield* Ref.get(changed)))
								return ConfigProvider.makeValue("a")
							yield* Deferred.succeed(refreshing, undefined)
							yield* Deferred.await(releaseRead)
							return ConfigProvider.makeValue("b")
						}),
					),
				),
			)
			yield* Effect.gen(function* () {
				yield* Graft.provide(Gate, "available")
				const entry = {
					...(kind === "injected" ? { inject: [Gate.key] } : {}),
					id: "leaf",
					name: "leaf",
					config: new Entry.Env({ name: "VALUE" }),
					intercept: { [setting.key]: "value" },
				}
				yield* Graft.plugin(
					Loader.plugin,
					kind === "nested" || kind === "injected group"
						? [
								{
									id: "group",
									name: "group",
									group: true,
									config: [entry],
									...(kind === "injected group" ? { inject: [Gate.key] } : {}),
								},
							]
						: [entry],
				)
				const loader = yield* loaderService
				yield* Deferred.await(resolving)
				yield* Ref.set(changed, true)
				yield* Graft.forks.pipe(
					Stream.filter((trees) => {
						const visit = (nodes: typeof trees): boolean =>
							Array.some(
								nodes,
								(n) =>
									(n.id === loader.root.id && n.state._tag === "Active") ||
									visit(n.children),
							)
						return visit(trees)
					}),
					Stream.runHead,
				)
				const reconciled = yield* Graft.forks.pipe(
					Stream.drop(1),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				yield* loader.retry
				yield* Fiber.join(reconciled)
				yield* Deferred.succeed(releaseImport, undefined)
				yield* Deferred.await(refreshing)
				yield* Graft.forks.pipe(
					Stream.filter((trees) => {
						const visit = (nodes: typeof trees): boolean =>
							Array.some(
								nodes,
								(n) =>
									(n.name === "leaf" &&
										n.input === "a" &&
										n.state._tag === "Active") ||
									visit(n.children),
							)
						return visit(trees)
					}),
					Stream.runHead,
				)
				yield* Deferred.succeed(releaseRead, undefined)
				yield* Deferred.await(updating)
				yield* loader.update("leaf", { config: "c" })
				const settled = yield* Deferred.make<void>()
				yield* loader.ready.pipe(
					Effect.andThen(Deferred.succeed(settled, undefined)),
					Effect.forkScoped,
				)
				// Drain runnable work while the refresh callback remains blocked.
				yield* TestClock.adjust("1 second")
				const early = yield* Deferred.isDone(laterStarted)
				const ready = yield* Deferred.isDone(settled)
				assert.isFalse(early)
				assert.isFalse(ready)
				yield* Deferred.succeed(releaseUpdate, undefined)
				yield* loader.ready
				const events = yield* Ref.get(journal)
				const interrupted = yield* Deferred.isDone(cancelled)
				assert.isFalse(interrupted)
				assert.deepStrictEqual(events, [
					"start a",
					"begin b",
					"end b",
					"begin c",
					"end c",
				])
			}).pipe(
				Effect.scoped,
				Effect.provide(Layer.provideMerge(Graft.layer, environment)),
			)
		}),
)
