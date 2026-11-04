/** Credentials and authenticated identities shared by transport plugins. */
import { Context } from "effect"
import type { Effect, Redacted, Option, Scope } from "effect"
import type { AuthenticationFailed, CredentialsError } from "./Errors"

export interface ClientCertificate {
	readonly cert: string
	readonly key: Redacted.Redacted<string>
}
export class Peer extends Context.Service<Peer, string>()(
	"@graftland/plugin-remote/Auth/Peer",
) {}
export interface PreparedCredentials {
	readonly certificate?: ClientCertificate
	readonly authorization?: Redacted.Redacted<string>
}

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
	"@graftland/plugin-remote/Auth/Credentials",
) {}
export class Authenticator extends Context.Service<
	Authenticator,
	AuthenticatorApi
>()("@graftland/plugin-remote/Auth/Authenticator") {}
