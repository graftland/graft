import type { Plugin } from "@graftland/graft"
import { Cause, Effect } from "effect"
import type { Context, Duration, Scope } from "effect"
import { MtlsCredentials, type ClientCertificate } from "./Auth"
import { LocalTransport, TlsTransport, type TlsOptions } from "./Transport"
import { RemoteError } from "./Errors"
import type { Expected } from "./internal/runner/Packages"

export interface CredentialSource<
	A,
	E,
	D extends ReadonlyArray<Plugin.Dependency>,
> {
	readonly inject: D
	readonly read: Effect.Effect<A, E, NoInfer<Plugin.Required<D>> | Scope.Scope>
}
export interface Mtls<
	D extends ReadonlyArray<Plugin.Dependency> = readonly [],
> {
	readonly _tag: "Mtls"
	readonly inject: D
	readonly read: Effect.Effect<
		ClientCertificate,
		RemoteError,
		Plugin.Required<D> | Scope.Scope
	>
}
export function mtls<E>(read: Effect.Effect<ClientCertificate, E>): Mtls
export function mtls<E, const D extends ReadonlyArray<Plugin.Dependency>>(
	source: CredentialSource<ClientCertificate, E, D>,
): Mtls<D>
export function mtls<E, const D extends ReadonlyArray<Plugin.Dependency>>(
	source:
		| Effect.Effect<ClientCertificate, E>
		| CredentialSource<ClientCertificate, E, D>,
): Mtls<D | readonly []> {
	const credentials: CredentialSource<ClientCertificate, E, D | readonly []> =
		Effect.isEffect(source) ? { inject: [], read: source } : source
	return {
		_tag: "Mtls",
		inject: credentials.inject,
		read: credentials.read.pipe(
			Effect.mapError((error) =>
				RemoteError.make({ cause: Cause.fail(error) }),
			),
		),
	}
}
export interface Tls extends TlsOptions {
	readonly _tag: "Tls"
}
/** Temporary raw TLS target; replaced by websocket in the next protocol stage. */
export const tls = (options: TlsOptions): Tls => ({ _tag: "Tls", ...options })
export interface Local {
	readonly _tag: "Local"
	readonly command?: readonly [string, ...string[]]
	readonly auth?: never
}
export interface Runner<
	D extends ReadonlyArray<Plugin.Dependency> = readonly [],
> {
	readonly _tag: "Runner"
	/** Defaults to the current loader entry id. Required outside a loader. */
	readonly instance?: string
	readonly transport: Tls
	readonly auth: Mtls<D>
	readonly lease?: Duration.Input
	readonly margin?: Duration.Input
	readonly expect?: Expected
}
export const local = (options: Omit<Local, "_tag"> = {}): Local => ({
	_tag: "Local",
	...options,
})
export const runner = <
	const D extends ReadonlyArray<Plugin.Dependency> = readonly [],
>(
	options: Omit<Runner<D>, "_tag">,
): Runner<D> => ({ _tag: "Runner", ...options })
export type Target<D extends ReadonlyArray<Plugin.Dependency> = readonly []> =
	Local | Runner<D>
/** Credential construction checks requirements; Graft consumes the resulting runtime keys. */
export const dependencies = <D extends ReadonlyArray<Plugin.Dependency>>(
	target: Target<D>,
): ReadonlyArray<
	Context.Key<unknown, unknown> | Plugin.Optional<Context.Key<unknown, unknown>>
> =>
	target._tag === "Local"
		? [LocalTransport]
		: [TlsTransport, MtlsCredentials, ...target.auth.inject]
