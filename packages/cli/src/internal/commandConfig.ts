import {
	Array,
	Config,
	Effect,
	FileSystem,
	HashMap,
	Option,
	Path,
	Predicate,
	Schema,
} from "effect"

import { parseDocument } from "yaml"

import { CommandConfigError } from "../Commands"

const Description = Schema.Struct({
	name: Schema.String,
	config: Schema.optionalKey(Schema.Unknown),
	disabled: Schema.optionalKey(Schema.Boolean),
})
export const home = Effect.gen(function* () {
	const path = yield* Path.Path
	const override = yield* Config.String("GRAFT_HOME").pipe(Config.option)
	if (Option.isSome(override)) return path.resolve(override.value)
	const directory = yield* Config.String("HOME")
	return path.join(directory, ".graft")
})
export const read = Effect.fnUntraced(function* (file: string) {
	const fs = yield* FileSystem.FileSystem
	if (!(yield* fs.exists(file))) return []
	const text = yield* fs.readFileString(file)
	const { Entry } = yield* Effect.promise(
		() => import("@graftland/loader"),
	).pipe(Effect.uninterruptible)
	const value = yield* Effect.try({
		try: () => {
			const document = parseDocument(text, {
				customTags: [
					{ tag: "!env", resolve: (name: string) => new Entry.Env({ name }) },
				],
			})
			const error = document.errors[0]
			if (error !== undefined) throw error
			return document.toJS()
		},
		catch: (cause) => CommandConfigError.make({ file, cause }),
	})
	const entries = yield* Schema.decodeUnknownEffect(
		Schema.NullOr(Schema.Array(Schema.Unknown)),
	)(value).pipe(
		Effect.mapError((cause) => CommandConfigError.make({ file, cause })),
	)
	return yield* Effect.forEach(
		Array.filter(
			entries ?? [],
			(entry) => Predicate.hasProperty(entry, "cli") && entry.cli === true,
		),
		(entry) =>
			Schema.decodeUnknownEffect(Description)(entry).pipe(
				Effect.mapBoth({
					onFailure: (cause) => CommandConfigError.make({ file, cause }),
					onSuccess: (entry) => ({ ...entry, file }),
				}),
			),
	)
})
export const discover = Effect.fnUntraced(function* (watch: boolean) {
	const path = yield* Path.Path
	const directory = yield* home
	const global = yield* read(path.join(directory, "graft.yml"))
	const project = yield* read(path.resolve("graft.yml")).pipe(
		Effect.catchTag("CommandConfigError", (error) =>
			watch
				? Effect.logWarning(
						"Command discovery skipped invalid project configuration; restart to load command plugins",
						error,
					).pipe(Effect.as([]))
				: Effect.fail(error),
		),
	)
	const merged = Array.reduce(
		[...global, ...project],
		HashMap.empty<string, (typeof global)[number]>(),
		(map, entry) => HashMap.set(map, entry.name, entry),
	)
	return Array.filter(
		Array.fromIterable(HashMap.values(merged)),
		(entry) => entry.disabled !== true,
	)
})
