/** Execution and byte-channel capabilities; implementations live in host plugins. */
import { Context } from "effect"
import type { Duration, Effect, PlatformError, Scope } from "effect"
import type { ProcessExited, TransportError } from "./Errors"
import type { PreparedCredentials } from "./Auth"
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

export interface WebsocketOptions {
	readonly url: string
	readonly tls?: {
		readonly ca?: string
		readonly servername?: string
	}
	readonly openTimeout?: Duration.Input
}
export class WebsocketTransport extends Context.Service<
	WebsocketTransport,
	{
		readonly connect: (
			options: WebsocketOptions,
			credentials?: PreparedCredentials,
		) => Effect.Effect<Channel, TransportError, Scope.Scope>
	}
>()("@graftland/remote/Transport/WebsocketTransport") {}

export interface UnixOptions {
	readonly path: string
}
export class UnixTransport extends Context.Service<
	UnixTransport,
	{
		readonly connect: (
			options: UnixOptions,
			credentials?: PreparedCredentials,
		) => Effect.Effect<Channel, TransportError, Scope.Scope>
	}
>()("@graftland/remote/Transport/UnixTransport") {}

export interface CommandOptions {
	readonly argv: readonly [string, ...string[]]
	readonly cwd?: string
	readonly env?: Readonly<Record<string, string>>
}
export class CommandTransport extends Context.Service<
	CommandTransport,
	{
		readonly connect: (
			options: CommandOptions,
		) => Effect.Effect<Channel, TransportError, Scope.Scope>
	}
>()("@graftland/remote/Transport/CommandTransport") {}
