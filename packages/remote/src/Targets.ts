import type { Plugin } from "@graftland/graft"
import { Cause, Effect, Schema } from "effect"
import type { Context, Duration, Scope } from "effect"
import { MtlsCredentials, NoCredentials, type ClientCertificate } from "./Auth"
import {
	LocalTransport,
	UnixTransport,
	CommandTransport,
	type UnixOptions,
	type CommandOptions,
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
export interface None {
	readonly _tag: "None"
}
export const none = (): None => ({ _tag: "None" })
export interface Unix extends UnixOptions {
	readonly _tag: "Unix"
}
export const unix = (options: UnixOptions): Unix => ({
	_tag: "Unix",
	...options,
})
export interface Command extends CommandOptions {
	readonly _tag: "Command"
	readonly auth?: never
}
export const command = (
	argv: CommandOptions["argv"],
	options: Omit<CommandOptions, "argv"> = {},
): Command => ({ _tag: "Command", argv, ...options })

interface RunnerCommon {
	readonly _tag: "Runner"
	/** Defaults to the current loader entry id. Required outside a loader. */
	readonly instance?: string
	readonly lease?: Duration.Input
	readonly margin?: Duration.Input
	readonly expect?: Expected
}
export type Runner<D extends ReadonlyArray<Plugin.Dependency> = readonly []> =
	RunnerCommon &
		(
			| { readonly transport: Websocket; readonly auth: Mtls<D> }
			| { readonly transport: Unix; readonly auth?: None }
			| { readonly transport: Command; readonly auth?: never }
		)
export const local = (options: Omit<Local, "_tag"> = {}): Local => ({
	_tag: "Local",
	...options,
})
export const runner = <
	const Url extends string,
	const D extends ReadonlyArray<Plugin.Dependency> = readonly [],
>(
	options: Omit<RunnerCommon, "_tag"> &
		(
			| {
					readonly transport: Websocket<Url> &
						(Url extends `ws://${string}` ? never : unknown)
					readonly auth: Mtls<D>
			  }
			| { readonly transport: Unix; readonly auth?: None }
			| { readonly transport: Command; readonly auth?: never }
		),
): Runner<D> => ({ _tag: "Runner", ...options })
export type Target<D extends ReadonlyArray<Plugin.Dependency> = readonly []> =
	Local | Runner<D>
/** Credential construction checks requirements; Graft consumes the resulting runtime keys. */
export const dependencies = <D extends ReadonlyArray<Plugin.Dependency>>(
	target: Target<D>,
): ReadonlyArray<
	Context.Key<unknown, unknown> | Plugin.Optional<Context.Key<unknown, unknown>>
> => {
	if (target._tag === "Local") return [LocalTransport]
	switch (target.transport._tag) {
		case "Command":
			return [CommandTransport]
		case "Unix":
			return [UnixTransport, NoCredentials]
		case "Websocket":
			return [
				WebsocketTransport,
				MtlsCredentials,
				...(target.auth?._tag === "Mtls" ? target.auth.inject : []),
			]
	}
}

export class InvalidTarget extends Schema.TaggedError<
	InvalidTarget,
	{ readonly brand: unique symbol }
>()("InvalidTarget", { detail: Schema.String }) {
	override get message() {
		return this.detail
	}
}
/** Dynamic configuration is checked before any transport or credential effect runs. */
export const validate = <D extends ReadonlyArray<Plugin.Dependency>>(
	target: Target<D>,
): Effect.Effect<void, InvalidTarget> => {
	if (target._tag === "Local") return Effect.void
	if (
		target.transport._tag === "Command" &&
		("auth" in target || "auth" in target.transport)
	)
		return Effect.fail(
			InvalidTarget.make({ detail: "Command transports do not accept auth" }),
		)
	if (
		target.transport._tag === "Unix" &&
		target.auth !== undefined &&
		target.auth._tag !== "None"
	)
		return Effect.fail(
			InvalidTarget.make({
				detail: "Unix transports only support none authentication",
			}),
		)
	return Effect.void
}
