/**
 * Runs a Graft application from its config file.
 */
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
	Scope,
	Semaphore,
	type PlatformError,
	type Schema,
} from "effect"
import { NodeServices } from "@effect/platform-node"

import { Graft, Plugin } from "@graftland/graft"
import * as Hmr from "@graftland/hmr"
import {
	Entry,
	Include,
	Loader,
	ModuleResolver,
	type Tree,
} from "@graftland/loader"

import { Application, ApplicationError, platform } from "./Application"
import {
	layer as env,
	EnvDir,
	EnvFile,
	watchEnvDir,
	watchEnvFile,
} from "./internal/env"
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
	/**
	 * A directory of secret files that `!env` reads when neither the process
	 * environment nor `envFile` sets a variable. Each regular file is one
	 * variable, named after the file. With `watch`, changes are read again.
	 */
	readonly envDir?: string | undefined
}

/**
 * Loads the entries of the config file and runs until interrupted. Plugin
 * modules are imported through the hot reloader, so bare specifiers resolve
 * from the application directory whether or not `watch` is on.
 */
export const run = (
	options: Options,
): Effect.Effect<
	void,
	| ApplicationError
	| Graft.ServiceConflict
	| PlatformError.BadArgument
	| PlatformError.PlatformError
	| Schema.SchemaError
	| Loader.StoreError
	| Tree.InvalidOperation
> =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const done = yield* Deferred.make<void, ApplicationError>()
		const protocol = yield* Semaphore.make(1)
		yield* Graft.provide(Application, {
			claimProtocol: Effect.acquireRelease(
				protocol.takeIfAvailable(1).pipe(
					Effect.flatMap((acquired) =>
						acquired
							? Effect.void
							: Effect.fail(
									ApplicationError.make({
										cause: Cause.fail(
											"Only one runner may own the process stdio channel",
										),
									}),
								),
					),
				),
				() => protocol.release(1),
			),
			finish: (exit) =>
				Deferred.done(
					done,
					Exit.isFailure(exit)
						? Exit.fail(ApplicationError.make({ cause: exit.cause }))
						: Exit.void,
				).pipe(Effect.asVoid),
			onExit: (release) => Scope.addFinalizer(scope, release),
		})
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
			importer: options.watch ? hmr.importModuleScoped : hmr.importModule,
		})
		yield* Graft.provide(ModuleResolver.ModuleResolver, {
			resolve: resolver.resolve,
			importModule: modules.importModule,
		})
		const fs = yield* FileSystem.FileSystem
		const observe = hmr.observation.pipe(
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.map((source) => ({
				...source,
				watch: (files: ReadonlyArray<string>, activation: Scope.Scope) =>
					source.watch(files, activation).pipe(
						Effect.mapError((cause) =>
							ModuleResolver.ModuleInvalid.make({
								specifier: Array.join(files, ", "),
								cause,
							}),
						),
					),
			})),
		)
		const included = yield* Graft.plugin(Include.Include, {
			path: file,
			watch: options.watch,
		}).pipe(
			Effect.provideService(
				ModuleResolver.Watch,
				options.watch ? Option.some(observe) : Option.none(),
			),
		)
		yield* included.await
		if (options.watch) {
			const { reload } = yield* EnvFile
			const { reload: reloadDir } = yield* EnvDir
			const { envFile, envDir } = options
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
						if (envDir !== undefined)
							yield* watchEnvDir(envDir, reloadDir, loader.retry).pipe(
								Effect.forkScoped,
							)
					}),
			})
			yield* Graft.plugin(reloader)
		}

		yield* Effect.logInfo(
			`Running ${path.relative(process.cwd(), file) || file}`,
		)
		return yield* Deferred.await(done)
	}).pipe(
		Effect.scoped,
		Effect.provideService(Entry.Select, (entry) => entry["cli"] !== true),
		// @effect-diagnostics-next-line strictEffectProvide:off -- this runs the whole application, so it is an entry point
		Effect.provide(
			Layer.provideMerge(
				Graft.layer,
				Layer.mergeAll(
					platform,
					intercepts,
					env({ file: options.envFile, dir: options.envDir }).pipe(
						Layer.provide(NodeServices.layer),
					),
					Logger.layer([Logger.consolePretty()]),
				),
			),
		),
	)
