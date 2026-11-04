import { Graft, Plugin } from "@graftland/graft"
import { Effect, FileSystem, Option, Path } from "effect"
import { Authenticator, type AuthenticatorApi } from "../../Auth"
import { ConfigDirectory } from "@graftland/loader"
import { identityFromSubjectAltName } from "../../internal/auth/mtls"

import { Mtls as Config } from "../../internal/auth/config"
export { Config }
const read = Effect.fnUntraced(function* (ca: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* ConfigDirectory.pipe(
		Effect.map(Option.getOrElse(() => ".")),
	)
	return yield* fs.readFileString(path.resolve(directory, ca))
})
export const make = (
	ca: string,
): Extract<AuthenticatorApi, { readonly _tag: "Mtls" }> => ({
	_tag: "Mtls",
	tls: {
		ca: [ca],
		minVersion: "TLSv1.3",
		requestCert: true,
		rejectUnauthorized: true,
	},
	authenticate: (peer) =>
		identityFromSubjectAltName(Option.getOrUndefined(peer.subjectAltName)),
})
export default Plugin.make({
	name: "remote-certificate-authenticator",
	config: Config,
	inject: [FileSystem.FileSystem, Path.Path],
	apply: ({ ca }) =>
		read(ca).pipe(
			Effect.flatMap((ca) => Graft.provide(Authenticator, make(ca))),
		),
})
