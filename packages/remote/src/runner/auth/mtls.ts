import { Graft, Plugin } from "@graftland/graft"
import { Cause, Effect, FileSystem, Option, Path, Schema } from "effect"
import {
	Authenticator,
	MtlsAuthenticator,
	type AuthenticatorApi,
} from "../../Auth"
import { AuthenticationFailed } from "../../Errors"
import { Directory } from "../../internal/config"
import { identityFromSubjectAltName } from "../../internal/auth/mtls"

export const Config = Schema.Struct({ ca: Schema.String })
const read = Effect.fnUntraced(function* (ca: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* Directory
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
		identityFromSubjectAltName(Option.getOrUndefined(peer.subjectAltName)).pipe(
			Effect.mapError((error) =>
				AuthenticationFailed.make({
					reason: "invalid",
					cause: Cause.fail(error),
				}),
			),
		),
})
export const capability = Plugin.make({
	name: "remote-certificate-authenticator",
	config: Config,
	inject: [FileSystem.FileSystem, Path.Path],
	apply: ({ ca }) =>
		read(ca).pipe(
			Effect.flatMap((ca) => Graft.provide(Authenticator, make(ca))),
		),
})

/** Transitional keyed provider for the existing runner entry. */
export default Plugin.make({
	name: "remote-mtls-authenticator",
	config: Config,
	inject: [FileSystem.FileSystem, Path.Path],
	apply: ({ ca }) =>
		read(ca).pipe(
			Effect.flatMap((ca) =>
				Graft.provide(MtlsAuthenticator, {
					_tag: "Mtls",
					ca,
					authenticate: identityFromSubjectAltName,
				}),
			),
		),
})
