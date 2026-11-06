import { Effect, FileSystem, Option, Path } from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"

import { Graft, Plugin } from "@graftland/graft"
import { ConfigDirectory, ModuleResolver } from "@graftland/loader"

import * as Control from "./Control"
import { make } from "./internal/service"
import { Config, Releases, type Options } from "./Model"

export * from "./Model"
export { build } from "./internal/storage"
export { Control }

const activate = Effect.fnUntraced(function* (options: Options) {
	const path = yield* Path.Path
	const directory = yield* ConfigDirectory
	const base = Option.getOrElse(directory, () => ".")
	const resolved: Options = {
		...options,
		store: path.resolve(base, options.store),
		...(options.socket === undefined
			? {}
			: { socket: path.resolve(base, options.socket) }),
	}
	const releases = yield* make(resolved)
	if (resolved.socket !== undefined)
		yield* Control.serve(resolved.socket, releases)
	yield* Graft.provide(Releases, releases)
})

/** Owns managed integrations; the host gateway remains outside this plugin's subtree. */
export const plugin = (options: Options) =>
	Plugin.make({
		name: "@graftland/plugin-release",
		inject: [
			FileSystem.FileSystem,
			Path.Path,
			SecureRandom.SecureRandom,
			ChildProcessSpawner.ChildProcessSpawner,
			ModuleResolver.ModuleResolver,
		],
		apply: () => activate(options),
	})

export default Plugin.make({
	name: "@graftland/plugin-release",
	config: Config,
	inject: [
		FileSystem.FileSystem,
		Path.Path,
		SecureRandom.SecureRandom,
		ChildProcessSpawner.ChildProcessSpawner,
		ModuleResolver.ModuleResolver,
	],
	apply: activate,
})
