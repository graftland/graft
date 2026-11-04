import { Graft, Plugin, type Fork } from "@graftland/graft"
import { Include, Loader, ModuleResolver, type Entry } from "@graftland/loader"
import { Array, Cause, Effect, Option, Path, Schema, Stream } from "effect"
import { Directory } from "./config"

export class StartupError extends Schema.TaggedError<
	StartupError,
	{ readonly brand: unique symbol }
>()("RunnerStartupError", {
	detail: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Defect())),
}) {
	override get message() {
		return this.detail
	}
}
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
const ready = Plugin.make({
	name: "remote-ready",
	inject: [Loader.Loader],
	apply: Effect.fnUntraced(function* () {
		const loader = yield* Loader.Loader
		yield* loader.ready
		// Pending can still be reacting to a provider published during startup.
		// Observe the loader's subtree, excluding this startup observer itself.
		yield* Graft.forks.pipe(
			Stream.map((trees) => subtree(trees, loader.root.id)),
			Stream.filter(Option.isSome),
			Stream.map((tree) => tree.value),
			Stream.tap((tree) => check([tree])),
			Stream.filter(active),
			Stream.runHead,
		)
	}),
})

const load = Effect.fnUntraced(function* (source: Source, directory: string) {
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
	return yield* Effect.never
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
	)
})
