/**
 * Runs a Graft application from its config file.
 */
import { NodeServices } from "@effect/platform-node"
import { Graft, Plugin } from "@nmnmcc/graft"
import * as Hmr from "@nmnmcc/graft-hmr"
import { Include, Loader, ModuleResolver } from "@nmnmcc/graft-loader"
import type { PlatformError } from "effect"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Path,
	Queue,
	Stream,
	String as Str,
} from "effect"

export interface Options {
	/** Path of the config file. */
	readonly config: string
	/** Reload plugin modules and the config file when they change. */
	readonly watch: boolean
}

const moduleExtensions = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]

/** Whether a change to this file should reload plugin modules. */
const isModule = (path: string) =>
	!Str.includes("node_modules")(path) &&
	Arr.some(moduleExtensions, (extension) => Str.endsWith(extension)(path))

const describe = (result: Hmr.ReloadResult) =>
	result._tag === "Reloaded"
		? Effect.logInfo(`Reloaded ${result.entries.length} plugin module(s)`)
		: Effect.logWarning(
				`Restart required to pick up ${Arr.join(result.modules, ", ")}`,
			)

/**
 * Loads the entries of the config file and runs until interrupted. Plugin
 * modules are imported through the hot reloader, so bare specifiers resolve
 * from the application directory whether or not `watch` is on.
 */
export const run = (
	options: Options,
): Effect.Effect<never, Graft.ServiceConflict | PlatformError.BadArgument> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const file = path.resolve(options.config)
		const directory = path.dirname(file)
		const base = yield* path.toFileUrl(file)
		const hmr = yield* Hmr.make({ base: base.href })
		const resolver = yield* ModuleResolver.make({
			base: directory,
			importer: hmr.importer,
		})
		yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
		yield* Graft.plugin(Include.Include, { path: file, watch: options.watch })
		if (options.watch) {
			// A save raises several events; a one-slot sliding queue folds them into one pending reload.
			const changed = yield* Queue.sliding<void>(1)
			// Only module changes reload code; the config file is watched by the loader itself.
			yield* fs.watch(directory, { recursive: true }).pipe(
				Stream.filter((event) => isModule(event.path)),
				Stream.runForEach(() => Queue.offer(changed, undefined)),
				Effect.forkScoped,
			)
			const reloader = Plugin.make({
				name: "reloader",
				inject: [Loader.Loader],
				apply: () =>
					Effect.gen(function* () {
						const loader = yield* Loader.Loader
						yield* Queue.take(changed).pipe(
							Effect.andThen(Effect.sleep("50 millis")),
							Effect.andThen(Queue.clear(changed)),
							Effect.andThen(hmr.reload),
							Effect.flatMap(describe),
							// Entries whose module failed to load get another chance with the new code.
							Effect.andThen(loader.retry),
							Effect.catchCause((cause) =>
								Effect.logError("Reloading plugin modules failed", cause),
							),
							Effect.forever,
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
					NodeServices.layer,
					Logger.layer([Logger.consolePretty()]),
				),
			),
		),
	)
