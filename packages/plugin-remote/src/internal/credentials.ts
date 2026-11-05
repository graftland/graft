import { Cause, Context, Effect, Redacted, Scope } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Credentials, type ClientCertificate, type Prepared } from "../Auth"
import { CredentialsError } from "../Errors"
import { prepare } from "./auth/token"
import type * as Configuration from "./entryConfig"

export type Source<A, D extends ReadonlyArray<Plugin.Dependency>, E = unknown> =
	| Effect.Effect<A, E, Scope.Scope>
	| {
			readonly inject: D
			readonly read: Effect.Effect<
				A,
				unknown,
				NoInfer<Plugin.Required<D>> | Scope.Scope
			>
	  }
/** A token value, a file, or a credential effect with declared dependencies. */
export type Token<D extends ReadonlyArray<Plugin.Dependency>> =
	string | { readonly file: string } | Source<Redacted.Redacted<string>, D>
/** Authentication configuration shared by TypeScript connection descriptions. */
export type Authentication<D extends ReadonlyArray<Plugin.Dependency>> =
	| { readonly name: string; readonly config?: unknown }
	| { readonly none: { readonly identity?: string } }
	| {
			readonly mtls:
				| { readonly cert: string; readonly key: string }
				| Source<ClientCertificate, D>
	  }
	| { readonly bearer: { readonly token: Token<D> } }
	| { readonly jwt: { readonly token: Token<D> } }
export type Connect<D extends ReadonlyArray<Plugin.Dependency> = readonly []> =
	typeof Configuration.Connect.Encoded extends infer C
		? C extends
				| { readonly local: object }
				| { readonly worker: object }
				| { readonly command: ReadonlyArray<string> }
			? C
			: Omit<C, "auth"> & { readonly auth?: Authentication<D> }
		: never

const provider = <A, E, D extends ReadonlyArray<Plugin.Dependency>>(
	source: Source<A, D, E>,
	encode: (
		read: Effect.Effect<A, CredentialsError, Scope.Scope>,
	) => typeof Credentials.Service,
) => {
	const input = Effect.isEffect(source) ? { inject: [], read: source } : source
	return Plugin.make({
		name: "remote-effect-credentials",
		inject: input.inject,
		apply: Effect.fnUntraced(function* () {
			// Restore the provider's context without replacing each read's owning scope.
			const context = yield* Effect.context<
				Plugin.Required<D> | Scope.Scope
			>().pipe(Effect.map(Context.omit(Scope.Scope)))
			const read = input.read.pipe(
				Effect.provideContext(context),
				Effect.mapError((error) =>
					CredentialsError.make({ cause: Cause.fail(error) }),
				),
			)
			yield* Graft.provide(Credentials, encode(read))
		}),
	})
}
export const invocation = <D extends ReadonlyArray<Plugin.Dependency>>(
	connect: Connect<D>,
) => {
	const auth = connect.auth
	if (auth === undefined) return undefined
	if ("mtls" in auth) {
		const source = auth.mtls
		if (Effect.isEffect(source) || "read" in source)
			return {
				plugin: provider(source, (read) => ({
					kind: "Certificate",
					read: read.pipe(
						Effect.map(
							(value): Extract<Prepared, { readonly _tag: "Certificate" }> => ({
								_tag: "Certificate",
								value,
							}),
						),
					),
				})),
				config: undefined,
			}
	}
	if ("bearer" in auth || "jwt" in auth) {
		const source = "bearer" in auth ? auth.bearer.token : auth.jwt.token
		if (
			typeof source !== "string" &&
			(Effect.isEffect(source) || "read" in source)
		)
			return {
				plugin: provider(source, (read) => ({
					kind: "Authorization",
					read: read.pipe(
						Effect.flatMap(prepare),
						Effect.map(
							(
								value,
							): Extract<Prepared, { readonly _tag: "Authorization" }> => ({
								_tag: "Authorization",
								value,
							}),
						),
					),
				})),
				config: undefined,
			}
	}
	return undefined
}
