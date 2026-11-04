import { Graft, Plugin, type Fork } from "@graftland/graft"
import { Include, Loader, ModuleResolver, type Entry } from "@graftland/loader"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Logger,
	Option,
	Path,
	Stream,
} from "effect"
import { Directory } from "./config"

import { ServeLifecycle, StartupError, make } from "./ServeLifecycle"
import { cleanupCause } from "./cleanup"
export { StartupError } from "./ServeLifecycle"

export type Source =
	| { readonly _tag: "Config"; readonly config: string }
	| { readonly _tag: "Entries"; readonly entries: ReadonlyArray<Entry.Entry> }

const check = (
	trees: ReadonlyArray<Fork.ForkTree>,
): Effect.Effect<void, StartupError> =>
	Effect.forEach(
		trees,
		(tree) => {
			if (tree.state._tag === "Failed")
				return Effect.fail(
					StartupError.make({
						detail: `Runner entry ${tree.name} failed`,
						cause: tree.state.cause,
					}),
				)
			return check(tree.children)
		},
		{ discard: true },
	)
const subtree = (
	trees: ReadonlyArray<Fork.ForkTree>,
	id: number,
): Option.Option<Fork.ForkTree> =>
	Array.findFirst(trees, (tree) =>
		tree.id === id ? Option.some(tree) : subtree(tree.children, id),
	)
const active = (tree: Fork.ForkTree): boolean =>
	tree.state._tag === "Active" && Array.every(tree.children, active)
/** Fork names identify listeners regardless of how their modules were resolved. */
const listeners = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<string> =>
	Array.flatMap(trees, (tree) => [
		...(Array.contains(
			[
				"remote-stdio-listener",
				"remote-unix-listener",
				"remote-websocket-listener",
			],
			tree.name,
		)
			? [tree.name]
			: []),
		...listeners(tree.children),
	])
const exclusive = (tree: Fork.ForkTree) => {
	const names = listeners([tree])
	return Array.contains(names, "remote-stdio-listener") && names.length !== 1
		? Effect.fail(
				StartupError.make({
					detail: "A stdio listener must be the only listener in serve",
				}),
			)
		: Effect.void
}
const ready = Plugin.make({
	name: "remote-ready",
	inject: [Loader.Loader],
	apply: Effect.fnUntraced(function* () {
		const loader = yield* Loader.Loader
		// A failed authenticator can leave its listener child Pending while the outer plugin is Applying.
		yield* loader.ready.pipe(
			Effect.raceFirst(
				Graft.forks.pipe(
					Stream.map((trees) => subtree(trees, loader.root.id)),
					Stream.filter(Option.isSome),
					Stream.runForEach((tree) => check([tree.value])),
				),
			),
		)
		// Pending can still be reacting to a provider published during startup.
		// Observe the loader's subtree, excluding this startup observer itself.
		yield* Graft.forks.pipe(
			Stream.map((trees) => subtree(trees, loader.root.id)),
			Stream.filter(Option.isSome),
			Stream.map((tree) => tree.value),
			Stream.tap((tree) => check([tree])),
			Stream.tap(exclusive),
			Stream.filter(active),
			Stream.runHead,
		)
	}),
})

/** Loader logs child cleanup errors; the supervisor's release signal also reaches the command exit. */
const close = (entries: Fork.Fork, lifecycle: typeof ServeLifecycle.Service) =>
	Effect.gen(function* () {
		const disposed = yield* Effect.exit(entries.dispose)
		const released = yield* Effect.exit(Deferred.await(lifecycle.released))
		const cause = Array.reduce(
			[disposed, released],
			Cause.empty,
			(cause: Cause.Cause<unknown>, exit: Exit.Exit<void, unknown>) =>
				Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause,
		)
		if (cause.reasons.length > 0)
			return yield* Effect.failCause(cleanupCause(cause))
	})

const load = Effect.fnUntraced(function* (source: Source, directory: string) {
	const lifecycle = yield* make
	yield* Graft.provide(ServeLifecycle, lifecycle)
	const resolver = yield* ModuleResolver.make({
		base: directory,
		importer: (specifier) => import(specifier),
	})
	yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
	const entries = yield* source._tag === "Config"
		? Graft.plugin(Include.Include, { path: source.config, watch: false })
		: Graft.plugin(Loader.plugin, source.entries)
	yield* entries.await
	const startup = yield* Graft.plugin(ready)
	yield* startup.await
	return yield* Deferred.await(lifecycle.ended).pipe(
		Effect.ensuring(close(entries, lifecycle)),
	)
})
export const run = Effect.fnUntraced(function* (source: Source) {
	const path = yield* Path.Path
	const directory =
		source._tag === "Config"
			? path.dirname(path.resolve(source.config))
			: path.resolve(".")
	return yield* load(source, directory).pipe(
		Effect.mapError((error) =>
			StartupError.make({
				detail: "Starting the runner failed",
				cause: Cause.fail(error),
			}),
		),
		Effect.provideService(Directory, directory),
		Effect.provideService(Logger.LogToStderr, true),
	)
})
