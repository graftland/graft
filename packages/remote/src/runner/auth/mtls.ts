import { Graft, Plugin } from "@graftland/graft"
import { Effect, FileSystem, Path, Schema } from "effect"
import { MtlsAuthenticator } from "../../Auth"
import { Directory } from "../../internal/config"
import { identityFromSubjectAltName } from "../../internal/auth/mtls"

export default Plugin.make({
	name: "remote-mtls-authenticator",
	config: Schema.Struct({ ca: Schema.String }),
	inject: [FileSystem.FileSystem, Path.Path],
	apply: Effect.fnUntraced(function* ({ ca }) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = yield* Directory
		yield* Graft.provide(MtlsAuthenticator, {
			ca: yield* fs.readFileString(path.resolve(directory, ca)),
			authenticate: identityFromSubjectAltName,
		})
	}),
})
