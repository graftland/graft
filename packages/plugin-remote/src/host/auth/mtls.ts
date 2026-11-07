import { Cause, Effect, FileSystem, Option, Path, Redacted } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { ConfigDirectory } from "@graftland/loader"

import { Credentials, type Prepared } from "../../Auth"
import { CredentialsError } from "../../Errors"
import { Certificate as Config } from "../../internal/auth/config"

export { Config }
export default Plugin.make({
	name: "@graftland/plugin-remote/host/auth/mtls",
	config: Config,
	inject: [FileSystem.FileSystem, Path.Path],
	apply: Effect.fnUntraced(function* (config) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = yield* ConfigDirectory.pipe(
			Effect.map(Option.getOrElse(() => ".")),
		)
		yield* Graft.provide(Credentials, {
			kind: "Certificate",
			// File credentials are read for each connection, not cached on activation.
			read: Effect.all({
				cert: fs.readFileString(path.resolve(directory, config.cert)),
				key: fs
					.readFileString(path.resolve(directory, config.key))
					.pipe(Effect.map(Redacted.make)),
			}).pipe(
				Effect.mapBoth({
					onSuccess: (
						value,
					): Extract<Prepared, { readonly _tag: "Certificate" }> => ({
						_tag: "Certificate",
						value,
					}),
					onFailure: (error) =>
						CredentialsError.make({ cause: Cause.fail(error) }),
				}),
			),
		})
	}),
})
