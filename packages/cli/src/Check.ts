/** Metadata-only preflight. No implementation module is imported. */
import { Array, Console, Effect, FileSystem, Path, Schema } from "effect"
import { CliError } from "effect/cli"

import { Manifest } from "@graftland/graft"

export const Selection = Schema.Struct({
	id: Schema.NonEmptyString,
	directory: Schema.NonEmptyString,
	entry: Schema.String,
})
export const Configuration = Schema.Struct({
	host: Manifest.Host,
	entries: Schema.Array(Selection),
	catalog: Schema.Array(Selection),
})
export type Configuration = typeof Configuration.Type
/** Paths in the preflight file are resolved relative to that file. */
export const inspect = Effect.fn("Check.inspect")(function* (file: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const configuration = yield* fs
		.readFileString(file)
		.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration)),
			),
		)
	const load = Effect.fnUntraced(function* (selection: typeof Selection.Type) {
		const directory = path.resolve(path.dirname(file), selection.directory)
		const pkg = yield* fs
			.readFileString(path.join(directory, "package.json"))
			.pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest.Package)),
				),
			)
		return {
			id: selection.id,
			entry: selection.entry,
			package: pkg,
		} satisfies Manifest.Selection
	})
	const entries = yield* Effect.forEach(configuration.entries, load)
	const catalog = yield* Effect.forEach(configuration.catalog, load)
	return Manifest.check(configuration.host, entries, catalog)
})
export const run = Effect.fn("Check.run")(
	function* (file: string) {
		const diagnostics = yield* inspect(file)
		if (diagnostics.length > 0)
			return yield* CliError.UserError.make({
				cause: diagnostics,
				userMessage: Array.join(
					Array.map(
						diagnostics,
						(item) => `[${item.code}] ${item.entry}: ${item.message}`,
					),
					"\n",
				),
			})
		yield* Console.log(
			"Compatible: all selected entries meet the declared host requirements",
		)
	},
	Effect.mapError((cause) =>
		CliError.isCliError(cause)
			? cause
			: CliError.UserError.make({
					cause,
					userMessage: `Cannot check manifests: ${cause.message}`,
				}),
	),
)
