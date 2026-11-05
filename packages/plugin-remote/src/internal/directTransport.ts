import {
	Context,
	type Effect,
	type Option,
	type PlatformError,
	type Scope,
} from "effect"

import type { ProcessExited, TransportError } from "../Errors"
import type { Channel } from "../Transport"

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
>()("@graftland/plugin-remote/internal/directTransport/LocalTransport") {}

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
>()("@graftland/plugin-remote/internal/directTransport/WorkerTransport") {}
