import type { Duration } from "effect"
import type { Credentials } from "./internal/runner/Tls"
import type { Expected } from "./internal/runner/Packages"

export interface Local {
	readonly _tag: "Local"
	readonly command?: readonly [string, ...string[]]
}
export interface Runner {
	readonly _tag: "Runner"
	readonly host: string
	readonly port: number
	readonly tls: Credentials & { readonly servername: string }
	readonly lease?: Duration.Input
	readonly margin?: Duration.Input
	readonly expect?: Expected
}
export const local = (options: Omit<Local, "_tag"> = {}): Local => ({
	_tag: "Local",
	...options,
})
export const runner = (options: Omit<Runner, "_tag">): Runner => ({
	_tag: "Runner",
	...options,
})
export type Target = Local | Runner
