import type { Plugin } from "@graftland/graft"
import { Cause, Effect } from "effect"
import type { Context, Duration, Scope } from "effect"
import { MtlsCredentials, type ClientCertificate } from "./Auth"
import {
	LocalTransport,
	WebsocketTransport,
	type WebsocketOptions,
} from "./Transport"
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
export interface Websocket<
	Url extends string = string,
> extends WebsocketOptions {
	readonly _tag: "Websocket"
	readonly url: Url
}
export const websocket = <const Url extends string>(
	options: Omit<Websocket<Url>, "_tag">,
): Websocket<Url> => ({ _tag: "Websocket", ...options })
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
	readonly transport: Websocket
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
	const Url extends string,
	const D extends ReadonlyArray<Plugin.Dependency> = readonly [],
>(
	options: Omit<Runner<D>, "_tag" | "transport"> & {
		readonly transport: Websocket<Url> &
			(Url extends `ws://${string}` ? never : unknown)
	},
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
		: [WebsocketTransport, MtlsCredentials, ...target.auth.inject]
