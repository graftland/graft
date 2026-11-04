/** Credentials and authenticated identities shared by transport plugins. */
import { Context } from "effect"
import type { Effect, Redacted } from "effect"
import type { PeerAuthenticationError } from "./internal/runner/model"

export interface ClientCertificate {
	readonly cert: string
	readonly key: Redacted.Redacted<string>
}
export class Peer extends Context.Service<Peer, string>()(
	"@graftland/remote/Auth/Peer",
) {}
export class MtlsCredentials extends Context.Service<
	MtlsCredentials,
	{
		readonly prepare: (
			certificate: ClientCertificate,
		) => Effect.Effect<ClientCertificate>
	}
>()("@graftland/remote/Auth/MtlsCredentials") {}
export class MtlsAuthenticator extends Context.Service<
	MtlsAuthenticator,
	{
		readonly ca: string
		readonly authenticate: (
			subjectAltName: string | undefined,
		) => Effect.Effect<string, PeerAuthenticationError>
	}
>()("@graftland/remote/Auth/MtlsAuthenticator") {}
