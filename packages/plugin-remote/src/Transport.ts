/** Execution and byte-channel capabilities; implementations live in host plugins. */
import {
	Context,
	type Effect,
	type Option,
	type Redacted,
	type Scope,
	type Sink,
	type Stream,
} from "effect"

import type { Prepared, TlsPolicy, VerifiedCertificate } from "./Auth"
import type {
	AuthenticationFailed,
	AuthenticatorUnavailable,
	TransportError,
} from "./Errors"

/** Ordered reliable bytes. Chunk boundaries have no meaning; EOF is not exit confirmation. */
export interface Channel {
	readonly input: Stream.Stream<Uint8Array, TransportError>
	readonly output: Sink.Sink<unknown, Uint8Array, unknown, TransportError>
}

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
) => Effect.Effect<Session, AuthenticationFailed | AuthenticatorUnavailable>
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
