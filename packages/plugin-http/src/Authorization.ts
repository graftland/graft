/** Resource-server capabilities shared by HTTP transports and authorization plugins. */
import { Context, Effect, Schema, type Redacted } from "effect"
import {
	HttpServerRespondable,
	HttpServerResponse,
	type HttpRouter,
} from "effect/http"

/** One OAuth scope token, as defined by RFC 6749 section 3.3 (used by RFC 6750). */
export const ScopeToken = Schema.String.check(
	Schema.isPattern(/^[\x21\x23-\x5b\x5d-\x7e]+$/u),
)

/** The verified identity and grants for the current request. */
export class Principal extends Context.Service<
	Principal,
	{
		readonly subject: string
		readonly issuer: string
		readonly audience: ReadonlyArray<string>
		readonly scopes: ReadonlyArray<string>
	}
>()("@graftland/plugin-http/Authorization/Principal") {}

export class InvalidToken extends Schema.TaggedError<
	InvalidToken,
	{ readonly brand: unique symbol }
>()("InvalidToken", { cause: Schema.Defect() }) {}
export class ValidationUnavailable extends Schema.TaggedError<
	ValidationUnavailable,
	{ readonly brand: unique symbol }
>()("ValidationUnavailable", { cause: Schema.Defect() }) {
	[HttpServerRespondable.symbol]() {
		return Effect.succeed(HttpServerResponse.empty({ status: 503 }))
	}
}

/** Validate opaque or JWT access tokens without coupling mounts to a validator implementation. */
export class TokenValidator extends Context.Service<
	TokenValidator,
	{
		readonly validate: (
			token: Redacted.Redacted<string>,
		) => Effect.Effect<
			Principal["Service"],
			InvalidToken | ValidationUnavailable
		>
	}
>()("@graftland/plugin-http/Authorization/TokenValidator") {}

export class Unauthorized extends Schema.TaggedError<
	Unauthorized,
	{ readonly brand: unique symbol }
>()("Unauthorized", {
	challenge: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {
	[HttpServerRespondable.symbol]() {
		return Effect.succeed(
			HttpServerResponse.empty({
				status: 401,
				headers: { "www-authenticate": this.challenge },
			}),
		)
	}
}
export class InsufficientScope extends Schema.TaggedError<
	InsufficientScope,
	{ readonly brand: unique symbol }
>()("InsufficientScope", {
	challenge: Schema.String,
	scopes: Schema.Array(Schema.String),
	cause: Schema.Defect(),
}) {
	[HttpServerRespondable.symbol]() {
		return Effect.succeed(
			HttpServerResponse.empty({
				status: 403,
				headers: { "www-authenticate": this.challenge },
			}),
		)
	}
}
export class AuthorizationConfigurationError extends Schema.TaggedError<
	AuthorizationConfigurationError,
	{ readonly brand: unique symbol }
>()("AuthorizationConfigurationError", { cause: Schema.Defect() }) {}

/** Middleware for the protected path and its descendants; other paths return 404. */
export type Protection = HttpRouter.Middleware<{
	provides: Principal
	handles: never
	error: Unauthorized | InsufficientScope | ValidationUnavailable
	requires: never
	layerError: AuthorizationConfigurationError
	layerRequires: never
}>
export class Authorization extends Context.Service<
	Authorization,
	{
		readonly protect: (options: {
			readonly path: `/${string}`
			readonly scopes: ReadonlyArray<string>
		}) => Protection
	}
	// @effect-diagnostics-next-line deterministicKeys:off -- the resource-server contract specifies the module and binding in this public key
>()("@graftland/plugin-http/Authorization/Authorization") {}
