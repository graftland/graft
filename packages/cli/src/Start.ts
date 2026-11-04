/**
 * Runs a Graft application from its config file.
 */
import { NodeServices } from "@effect/platform-node"
import { SecureRandom } from "effect/crypto"
import { Graft, Plugin } from "@graftland/graft"
import * as Hmr from "@graftland/hmr"
import { Include, Loader, ModuleResolver, type Tree } from "@graftland/loader"
import type { PlatformError, Schema } from "effect"
import { Effect, FileSystem, Layer, Logger, Path } from "effect"
import { EnvFile, layer as env, watchEnvFile } from "./internal/env"
import { layer as intercepts } from "./internal/intercepts"
import { watchModules } from "./internal/watch"

export interface Options {
	/** Path of the config file. */
	readonly config: string
	/** Reload plugin modules and the config file when they change. */
	readonly watch: boolean
	/**
	 * A `.env` file that `!env` reads when the process environment does not set
	 * a variable. With `watch`, changes to it are read again.
	 */
	readonly envFile?: string | undefined
}

/**
 * Loads the entries of the config file and runs until interrupted. Plugin
 * modules are imported through the hot reloader, so bare specifiers resolve
 * from the application directory whether or not `watch` is on.
 */
export const run = (
	options: Options,
): Effect.Effect<
	never,
	| Graft.ServiceConflict
	| PlatformError.BadArgument
	| PlatformError.PlatformError
	| Schema.SchemaError
	| Loader.StoreError
	| Tree.InvalidOperation
> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const file = path.resolve(options.config)
		const directory = path.dirname(file)
		const base = yield* path.toFileUrl(file)
		const hmr = yield* Hmr.make({ base: base.href })
		const resolver = yield* ModuleResolver.make({
			base: directory,
			importer: hmr.importerScoped,
		})
		const modules = yield* ModuleResolver.make({
			base: directory,
			importer: hmr.importModule,
		})
		yield* Graft.provide(ModuleResolver.ModuleResolver, {
			resolve: resolver.resolve,
			importModule: modules.importModule,
		})
		const included = yield* Graft.plugin(Include.Include, {
			path: file,
			watch: options.watch,
		})
		yield* included.await
		if (options.watch) {
			const { reload } = yield* EnvFile
			const envFile = options.envFile
			const reloader = Plugin.make({
				name: "reloader",
				inject: [Loader.Loader, FileSystem.FileSystem, Path.Path],
				apply: () =>
					Effect.gen(function* () {
						const loader = yield* Loader.Loader
						yield* watchModules(hmr, directory, loader.retry).pipe(
							Effect.forkScoped,
						)
						if (envFile !== undefined)
							yield* watchEnvFile(envFile, reload, loader.retry).pipe(
								Effect.forkScoped,
							)
					}),
			})
			yield* Graft.plugin(reloader)
		}

		yield* Effect.logInfo(
			`Running ${path.relative(process.cwd(), file) || file}`,
		)
		return yield* Effect.never
	}).pipe(
		Effect.scoped,
		// @effect-diagnostics-next-line strictEffectProvide:off -- this runs the whole application, so it is an entry point
		Effect.provide(
			Layer.provideMerge(
				Graft.layer,
				Layer.mergeAll(
					SecureRandom.layerWebCrypto,
					NodeServices.layer,
					intercepts,
					env(options.envFile).pipe(Layer.provide(NodeServices.layer)),
					Logger.layer([Logger.consolePretty()]),
				),
			),
		),
	)
