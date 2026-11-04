import { assert, describe, it } from "@effect/vitest"
import { Graft, Plugin } from "@graftland/graft"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Loader, ModuleResolver } from "../src/index.ts"
import { echo, loaderService, makeJournal, run } from "./utils.ts"

class Dependency extends Context.Service<Dependency, string>()(
	"@graftland/loader/test/group-lifecycle.test/Dependency",
) {}

describe("group lifecycle", () => {
	it.effect(
		"settles pending injections and applies their latest config when the service arrives",
		() =>
			run((journal) => ({ echo: echo(journal) }))((journal) =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "echo",
							name: "echo",
							inject: [Dependency.key],
							config: { text: "old" },
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					yield* journal.expect([])
					yield* loader.update("echo", { config: { text: "latest" } })
					yield* loader.ready
					yield* Graft.provide(Dependency, "available")
					yield* loader.ready
					// A service publication can precede the supervisor observing it.
					// A retry waits for reconciliation to accept the current tree.
					yield* loader.retry
					yield* loader.ready
					yield* journal.expect(["start latest"])
					yield* loader.update("echo", { config: { text: "updated" } })
					yield* loader.ready
					yield* journal.expect([
						"start latest",
						"stop latest",
						"start updated",
					])
				}),
			),
	)

	it.effect("retries unresolved injected entries inside nested groups", () =>
		Effect.gen(function* () {
			const journal = yield* makeJournal
			const available = yield* Ref.make(false)
			const resolver = Layer.succeed(ModuleResolver.ModuleResolver, {
				importModule: (specifier) =>
					Effect.fail(
						ModuleResolver.ModuleInvalid.make({
							specifier,
							cause: "Unused in this fixture",
						}),
					),
				resolve: (name) =>
					Effect.flatMap(Ref.get(available), (ok) =>
						ok
							? Effect.succeed<Plugin.Plugin>(echo(journal))
							: Effect.fail(
									ModuleResolver.ModuleNotFound.make({
										plugin: name,
										tried: [name],
									}),
								),
					),
			})
			yield* Effect.gen(function* () {
				yield* Graft.provide(Dependency, "available")
				yield* Graft.plugin(Loader.plugin, [
					{
						id: "group",
						name: "group",
						group: true,
						config: [
							{
								id: "nested",
								name: "group",
								group: true,
								config: [
									{
										id: "echo",
										name: "echo",
										inject: [Dependency.key],
										config: { text: "recovered" },
									},
								],
							},
						],
					},
				])
				const loader = yield* loaderService
				yield* loader.ready
				yield* journal.expect([])
				yield* Ref.set(available, true)
				yield* loader.retry
				yield* loader.ready
				yield* journal.expect(["start recovered"])
			}).pipe(
				Effect.scoped,
				Effect.provide(Graft.layer.pipe(Layer.provide(resolver))),
			)
		}),
	)

	it.effect(
		"removes a provider and its consumer without retaining a lease",
		() =>
			run((journal) => ({
				provider: Plugin.make({
					name: "provider",
					apply: () => Graft.provide(Dependency, "value"),
				}),
				consumer: Plugin.make({
					name: "consumer",
					inject: [Dependency],
					apply: () =>
						Effect.acquireRelease(journal.record("start consumer"), () =>
							journal.record("stop consumer"),
						),
				}),
			}))((journal) =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "group",
							name: "group",
							group: true,
							config: [
								{ id: "provider", name: "provider" },
								{ id: "consumer", name: "consumer" },
							],
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					yield* loader.update("group", { config: [] })
					yield* loader.ready
					yield* journal.expect(["start consumer", "stop consumer"])
				}),
			),
	)

	it.effect(
		"keeps the injected child instance when its update handler accepts config",
		() =>
			run((journal) => ({
				updatable: Plugin.make({
					name: "updatable",
					config: Schema.String,
					apply: (value) =>
						Effect.gen(function* () {
							yield* journal.record(`start ${value}`)
							return (next: string) =>
								Effect.as(journal.record(`update ${next}`), true)
						}),
				}),
			}))((journal) =>
				Effect.gen(function* () {
					yield* Graft.provide(Dependency, "available")
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "entry",
							name: "updatable",
							inject: [Dependency.key],
							config: "first",
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					yield* loader.update("entry", { config: "second" })
					yield* loader.ready
					yield* journal.expect(["start first", "update second"])
					const entries = yield* loader.entries
					assert.strictEqual(entries[0]?.config, "second")
				}),
			),
	)
})
