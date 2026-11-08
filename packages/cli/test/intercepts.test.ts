import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
	Queue,
	Ref,
	References,
	Schema,
	Stream,
	type Scope,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin, type Fork } from "@graftland/graft"
import { Include, Intercept, Loader } from "@graftland/loader"

import { layer as intercepts } from "../src/internal/intercepts"
import { fixture, FixtureDirectory, moduleLayer } from "./module-fixtures"

const run = <A, E>(
	plugins: Readonly<Record<string, string>>,
	program: Effect.Effect<
		A,
		E,
		| Graft.Graft
		| FileSystem.FileSystem
		| Path.Path
		| Scope.Scope
		| FixtureDirectory
	>,
) =>
	program.pipe(
		Effect.provide(
			Layer.provideMerge(
				Graft.layer,
				Layer.mergeAll(NodeServices.layer, moduleLayer(plugins), intercepts),
			),
		),
		Effect.scoped,
	)

const loadConfig = (text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const base = yield* FixtureDirectory
		const directory = yield* fs.makeTempDirectoryScoped({ directory: base })
		const file = `${directory}/graft.yml`
		yield* fs.writeFileString(file, text)
		const found = yield* Deferred.make<typeof Loader.Loader.Service>()
		yield* Graft.plugin(
			Plugin.make({
				name: "loader-observer",
				inject: [Loader.Loader],
				apply: () =>
					Effect.flatMap(Loader.Loader, (loader) =>
						Deferred.succeed(found, loader).pipe(Effect.asVoid),
					),
			}),
		)
		const included = yield* Graft.plugin(Include.Include, { path: file })
		yield* included.await
		const loader = yield* Deferred.await(found)
		yield* loader.ready
		return loader
	})

const flatten = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<Fork.ForkTree> =>
	Array.flatMap(trees, (tree) => [tree, ...flatten(tree.children)])

describe("CLI intercept registrations", () => {
	it.effect(
		"merges annotations and filters parent and child logs without affecting a sibling",
		() =>
			Effect.gen(function* () {
				const logs = yield* Queue.unbounded<{
					readonly message: string
					readonly annotations: Readonly<Record<string, unknown>>
				}>()
				const logger = Logger.layer([
					Logger.make((options) => {
						Queue.offerUnsafe(logs, {
							message: String(options.message),
							annotations: options.fiber.getRef(
								References.CurrentLogAnnotations,
							),
						})
					}),
				])
				const emit = (name: string) =>
					Effect.gen(function* () {
						yield* Effect.logDebug(`${name}:debug`)
						yield* Effect.logInfo(`${name}:info`)
						yield* Effect.logWarning(`${name}:warn`)
					})
				const child = Plugin.make({
					name: "child",
					config: Schema.String,
					apply: emit,
				})

				yield* run(
					{ parent: fixture("intercepts-parent-2959") },
					Effect.gen(function* () {
						yield* loadConfig(`
- id: restricted
  name: parent
  config: restricted
  intercept:
    effect/References/CurrentLogAnnotations:
      area: entry
      request: selected
    effect/References/MinimumLogLevel: Warn
- id: sibling
  name: parent
  config: sibling
- id: verbose
  name: parent
  config: verbose
  intercept:
    effect/References/MinimumLogLevel: Debug
`)
						const observed = yield* Queue.takeAll(logs)
						assert.sameMembers(
							Array.map(observed, (log) => log.message),
							[
								"restricted:warn",
								"restricted-child:warn",
								"sibling:info",
								"sibling:warn",
								"sibling-child:info",
								"sibling-child:warn",
								"verbose:debug",
								"verbose:info",
								"verbose:warn",
								"verbose-child:debug",
								"verbose-child:info",
								"verbose-child:warn",
							],
						)
						for (const log of observed) {
							assert.strictEqual(log.annotations["host"], "cli")
							if (
								log.message === "restricted:warn" ||
								log.message === "restricted-child:warn"
							) {
								assert.strictEqual(log.annotations["area"], "entry")
								assert.strictEqual(log.annotations["request"], "selected")
							} else {
								assert.strictEqual(log.annotations["area"], "outer")
								assert.isUndefined(log.annotations["request"])
							}
						}
					}),
				).pipe(
					Effect.provideService(
						Context.Service<{ readonly child: typeof child }>(
							"loader/fixture/intercepts-parent-2959",
						),
						{ child },
					),
					Effect.provide(logger),
					Effect.provideService(References.CurrentLogAnnotations, {
						host: "cli",
						area: "outer",
					}),
				)
			}),
	)

	it.effect.each([
		["MinimumLogLevel", '"warning"'],
		["MinimumLogLevel", "3"],
		["MinimumLogLevel", "{ level: Warn }"],
		["CurrentLogAnnotations", "[]"],
		["CurrentLogAnnotations", "null"],
		["CurrentLogAnnotations", "text"],
	])("rejects %s = %s as InvalidIntercept before apply", ([reference, input]) =>
		Effect.gen(function* () {
			const started = yield* Ref.make(false)

			yield* run(
				{ probe: fixture("intercepts-probe-5031") },
				Effect.gen(function* () {
					const key = `effect/References/${reference}`
					yield* loadConfig(`- id: invalid
  name: probe
  intercept:
    ${key}: ${input}
`)
					const trees = yield* Graft.forks.pipe(Stream.runHead)
					const failed = Option.getOrThrow(
						Array.findFirst(
							flatten(Option.getOrThrow(trees)),
							(tree) => tree.name === "probe",
						),
					)
					assert(failed.state._tag === "Failed")
					const error = Option.getOrThrow(
						Cause.findErrorOption(failed.state.cause),
					)
					assert(Schema.is(Intercept.InvalidIntercept)(error))
					assert.strictEqual(error.key, key)
					assert(Schema.isSchemaError(error.cause))
					const applied = yield* Ref.get(started)
					assert.isFalse(applied)
				}),
			).pipe(
				Effect.provideService(
					Context.Service<{ readonly started: typeof started }>(
						"loader/fixture/intercepts-probe-5031",
					),
					{ started },
				),
			)
		}),
	)
})
