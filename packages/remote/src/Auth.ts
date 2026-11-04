/** Credentials and authenticated identities shared by transport plugins. */
import { Context } from "effect"
import type { Effect, Redacted, Option, Scope } from "effect"
import type {
	AuthenticationFailed,
	CredentialsError,
	PeerAuthenticationError,
} from "./Errors"

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
export type LegacyAuthenticator =
	| HeaderAuthenticator
	| typeof MtlsAuthenticator.Service
	| typeof NoAuthenticator.Service

export interface VerifiedCertificate {
	readonly der: Uint8Array
	readonly subjectAltName: Option.Option<string>
}
export interface TlsPolicy {
	readonly ca: ReadonlyArray<string>
	readonly minVersion: "TLSv1.3"
	readonly requestCert: true
	readonly rejectUnauthorized: true
}
export type Prepared =
	| {
			readonly _tag: "Authorization"
			readonly value: Redacted.Redacted<string>
	  }
	| { readonly _tag: "Certificate"; readonly value: ClientCertificate }
	| { readonly _tag: "None" }

export type CredentialsApi = {
	[K in Prepared["_tag"]]: {
		readonly kind: K
		readonly read: Effect.Effect<
			Extract<Prepared, { readonly _tag: K }>,
			CredentialsError,
			Scope.Scope
		>
	}
}[Prepared["_tag"]]

export type AuthenticatorApi =
	| {
			readonly _tag: "Header"
			readonly issuer?: string
			readonly authenticate: (
				header: Option.Option<Redacted.Redacted<string>>,
			) => Effect.Effect<string, AuthenticationFailed>
	  }
	| {
			readonly _tag: "Mtls"
			readonly tls: TlsPolicy
			readonly authenticate: (
				peer: VerifiedCertificate,
			) => Effect.Effect<string, AuthenticationFailed>
	  }
	| { readonly _tag: "None"; readonly identity: string }

export class Credentials extends Context.Service<Credentials, CredentialsApi>()(
	"@graftland/remote/Auth/Credentials",
) {}
export class Authenticator extends Context.Service<
	Authenticator,
	AuthenticatorApi
>()("@graftland/remote/Auth/Authenticator") {}
