/** Execution and byte-channel capabilities; implementations live in host plugins. */
import { Context } from "effect"
import type { Duration, Effect, PlatformError, Scope } from "effect"
import type { ProcessExited, TransportError } from "./Errors"
import type { ClientCertificate } from "./Auth"
export type { Channel } from "./internal/port"
import type { Channel } from "./internal/port"

export interface LocalOptions {
	readonly command?: readonly [string, ...string[]]
	readonly contractModule: string
	readonly session: string
}
export interface Execution {
	readonly channel: Channel
	readonly pid: number
	readonly exited: Effect.Effect<ProcessExited, TransportError>
	readonly failure: Effect.Effect<never, TransportError>
}
export class LocalTransport extends Context.Service<
	LocalTransport,
	{
		readonly start: (
			options: LocalOptions,
		) => Effect.Effect<Execution, PlatformError.PlatformError, Scope.Scope>
	}
>()("@graftland/remote/Transport/LocalTransport") {}

export interface TlsOptions {
	readonly host: string
	readonly port: number
	readonly ca: string
	readonly servername: string
	readonly openTimeout?: Duration.Input
}
export class TlsTransport extends Context.Service<
	TlsTransport,
	{
		readonly connect: (
			options: TlsOptions,
			certificate: ClientCertificate,
		) => Effect.Effect<Channel, TransportError, Scope.Scope>
	}
>()("@graftland/remote/Transport/TlsTransport") {}
