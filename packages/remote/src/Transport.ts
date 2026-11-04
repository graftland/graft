/** Execution and byte-channel capabilities; implementations live in host plugins. */
import { Context } from "effect"
import type {
	Duration,
	Effect,
	Option,
	PlatformError,
	Scope,
	Stream,
	Sink,
	Redacted,
} from "effect"
import type {
	AuthenticationFailed,
	ProcessExited,
	TransportError,
} from "./Errors"
import type {
	PreparedCredentials,
	Prepared,
	VerifiedCertificate,
	TlsPolicy,
} from "./Auth"
/** Ordered reliable bytes. Chunk boundaries have no meaning; EOF is not exit confirmation. */
export interface Channel {
	readonly input: Stream.Stream<Uint8Array, TransportError>
	readonly output: Sink.Sink<unknown, Uint8Array, unknown, TransportError>
}

export interface LocalOptions {
	readonly command?: readonly [string, ...string[]]
	readonly contractModule: string
	readonly session: string
}
export interface Execution {
	readonly channel: Channel
	readonly pid: Option.Option<number>
	readonly threadId?: number
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
>()("@graftland/plugin-remote/Transport/LocalTransport") {}

export interface WorkerOptions {
	readonly execArgv?: ReadonlyArray<string>
	readonly contractModule: string
	readonly session: string
}
export class WorkerTransport extends Context.Service<
	WorkerTransport,
	{
		readonly start: (
			options: WorkerOptions,
		) => Effect.Effect<Execution, TransportError, Scope.Scope>
	}
>()("@graftland/plugin-remote/Transport/WorkerTransport") {}

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
>()("@graftland/plugin-remote/Transport/WebsocketTransport") {}

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
>()("@graftland/plugin-remote/Transport/UnixTransport") {}

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
>()("@graftland/plugin-remote/Transport/CommandTransport") {}

export interface Properties {
	readonly protocol: string
	readonly encrypted: boolean
	readonly network: boolean
	readonly carries: ReadonlyArray<"header" | "certificate">
}
export interface Handshake {
	readonly authorization: Option.Option<Redacted.Redacted<string>>
	readonly certificate: Option.Option<VerifiedCertificate>
}
export type Session = (
	channel: Channel,
) => Effect.Effect<void, TransportError, Scope.Scope>
export type Accept = (
	handshake: Handshake,
) => Effect.Effect<Session, AuthenticationFailed>
export interface Serving {
	/** Completes after serve has registered its accept loop, not merely after bind. */
	readonly ready: Effect.Effect<void>
	readonly serve: (
		accept: Accept,
	) => Effect.Effect<void, TransportError, Scope.Scope>
}
export interface ConnectorApi {
	readonly properties: Properties
	readonly connect: (
		credentials: Prepared,
	) => Effect.Effect<Channel, TransportError, Scope.Scope>
}
export interface ListenerApi {
	readonly properties: Properties
	readonly bind: (
		tls: Option.Option<TlsPolicy>,
	) => Effect.Effect<Serving, TransportError, Scope.Scope>
}
export class Connector extends Context.Service<Connector, ConnectorApi>()(
	"@graftland/plugin-remote/Transport/Connector",
) {}
export class Listener extends Context.Service<Listener, ListenerApi>()(
	"@graftland/plugin-remote/Transport/Listener",
) {}
