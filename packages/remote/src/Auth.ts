/** Credentials and authenticated identities shared by transport plugins. */
import { Context } from "effect"
import type { Effect, Redacted, Option } from "effect"
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
		readonly _tag: "Mtls"
		readonly ca: string
		readonly authenticate: (
			subjectAltName: string | undefined,
		) => Effect.Effect<string, PeerAuthenticationError>
	}
>()("@graftland/remote/Auth/MtlsAuthenticator") {}

export class NoCredentials extends Context.Service<
	NoCredentials,
	{
		readonly prepare: Effect.Effect<void>
	}
>()("@graftland/remote/Auth/NoCredentials") {}

export class NoAuthenticator extends Context.Service<
	NoAuthenticator,
	{
		readonly _tag: "None"
		readonly identity: string
	}
>()("@graftland/remote/Auth/NoAuthenticator") {}

export interface PreparedCredentials {
	readonly certificate?: ClientCertificate
	readonly authorization?: Redacted.Redacted<string>
}
export interface TokenCredentials {
	readonly prepare: (
		token: Redacted.Redacted<string>,
	) => Effect.Effect<Redacted.Redacted<string>>
}
export class BearerCredentials extends Context.Service<
	BearerCredentials,
	TokenCredentials
>()("@graftland/remote/Auth/BearerCredentials") {}
export class JwtCredentials extends Context.Service<
	JwtCredentials,
	TokenCredentials
>()("@graftland/remote/Auth/JwtCredentials") {}

export interface HeaderAuthenticator {
	readonly _tag: "Header"
	readonly authenticate: (
		authorization: Option.Option<Redacted.Redacted<string>>,
	) => Effect.Effect<string, PeerAuthenticationError>
}
export class BearerAuthenticator extends Context.Service<
	BearerAuthenticator,
	HeaderAuthenticator
>()("@graftland/remote/Auth/BearerAuthenticator") {}
export class JwtAuthenticator extends Context.Service<
	JwtAuthenticator,
	HeaderAuthenticator
>()("@graftland/remote/Auth/JwtAuthenticator") {}
export type Authenticator =
	| HeaderAuthenticator
	| typeof MtlsAuthenticator.Service
	| typeof NoAuthenticator.Service
