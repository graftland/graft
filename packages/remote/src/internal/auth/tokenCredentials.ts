import { Graft, Plugin } from "@graftland/graft"
import { ConfigDirectory } from "@graftland/loader"
import {
	Cause,
	Effect,
	FileSystem,
	Option,
	Path,
	Redacted,
	Schema,
} from "effect"
import { Credentials, type Prepared } from "../../Auth"
import { CredentialsError } from "../../Errors"
import { prepare } from "./token"

export const Config = Schema.Struct({
	token: Schema.Union([
		Schema.RedactedFromValue(Schema.String),
		Schema.Struct({ file: Schema.String }),
	]),
})
export const plugin = (
	name: string,
): Plugin.Plugin<
	typeof Config.Type,
	typeof Config.Encoded,
	Graft.ServiceConflict
> =>
	Plugin.make({
		name,
		config: Config,
		inject: [FileSystem.FileSystem, Path.Path],
		apply: Effect.fnUntraced(function* (config) {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const directory = yield* ConfigDirectory
			const token = config.token
			const read = Redacted.isRedacted(token)
				? Effect.succeed(token)
				: fs
						.readFileString(
							path.resolve(
								Option.getOrElse(directory, () => "."),
								token.file,
							),
						)
						.pipe(Effect.map(Redacted.make))
			yield* Graft.provide(Credentials, {
				kind: "Authorization",
				read: read.pipe(
					Effect.flatMap(prepare),
					Effect.mapBoth({
						onSuccess: (
							value,
						): Extract<Prepared, { readonly _tag: "Authorization" }> => ({
							_tag: "Authorization",
							value,
						}),
						onFailure: (error) =>
							CredentialsError.make({ cause: Cause.fail(error) }),
					}),
				),
			})
		}),
	})
