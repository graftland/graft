import { findSubtree, isSubtreeActive } from "./forkTree"
import { Graft, Plugin, type Fork } from "@graftland/graft"
import {
	ConfigDirectory,
	Include,
	Loader,
	ModuleResolver,
} from "@graftland/loader"
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
import * as Importer from "./importer"

import { ServeLifecycle, StartupError, make } from "./ServeLifecycle"
import { cleanupCause } from "./cleanup"
export { StartupError } from "./ServeLifecycle"

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
const ready = Plugin.make({
	name: "remote-ready",
	inject: [Loader.Loader],
	apply: Effect.fnUntraced(function* () {
		const loader = yield* Loader.Loader
		// A failed authenticator can leave its listener child Pending while the outer plugin is Applying.
		yield* loader.ready.pipe(
			Effect.raceFirst(
				Graft.forks.pipe(
					Stream.map((trees) => findSubtree(trees, loader.root.id)),
					Stream.filter(Option.isSome),
					Stream.runForEach((tree) => check([tree.value])),
				),
			),
		)
		// Pending can still be reacting to a provider published during startup.
		// Observe the loader's subtree, excluding this startup observer itself.
		yield* Graft.forks.pipe(
			Stream.map((trees) => findSubtree(trees, loader.root.id)),
			Stream.filter(Option.isSome),
			Stream.map((tree) => tree.value),
			Stream.tap((tree) => check([tree])),
			Stream.filter(isSubtreeActive),
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

const load = Effect.fnUntraced(function* (config: string, directory: string) {
	const lifecycle = yield* make
	yield* Graft.provide(ServeLifecycle, lifecycle)
	const importer = yield* Importer.make(directory)
	const resolver = yield* ModuleResolver.make({ base: directory, importer })
	yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
	const entries = yield* Graft.plugin(Include.Include, {
		path: config,
		watch: false,
	})
	yield* entries.await
	const startup = yield* Graft.plugin(ready)
	yield* startup.await
	return yield* Deferred.await(lifecycle.ended).pipe(
		Effect.ensuring(close(entries, lifecycle)),
	)
})
export const run = Effect.fnUntraced(function* (config: string) {
	const path = yield* Path.Path
	const file = path.resolve(config)
	const directory = path.dirname(file)
	return yield* load(file, directory).pipe(
		Effect.mapError((error) =>
			StartupError.make({
				detail: "Starting the runner failed",
				cause: Cause.fail(error),
			}),
		),
		Effect.provideService(ConfigDirectory, Option.some(directory)),
		Effect.provideService(Logger.LogToStderr, true),
	)
})
