import type { Duration } from "effect"
export interface WebsocketOptions {
	readonly url: string
	readonly tls?: {
		readonly ca?: string
		readonly servername?: string
	}
	readonly openTimeout?: Duration.Input
}
export interface UnixOptions {
	readonly path: string
}
export interface CommandOptions {
	readonly argv: readonly [string, ...string[]]
	readonly cwd?: string
	readonly env?: Readonly<Record<string, string>>
}
