import { Effect, String } from "effect"

export type Implementation =
	"graft" | "cordis" | "avvio" | "effect" | "node" | "emittery"
export type Scenario =
	| "cold-load"
	| "cold-dispose"
	| "fanout-load"
	| "fanout-withdraw"
	| "fanout-restore"
	| "chain"
	| "service"
	| "events-emit"
	| "events-sequential"
	| "events-parallel"
	| "events-bail"
	| "events-serial-bail"
	| "events-waterfall"
	| "config-update"
	| "config-restart"
	| "memory-cycles"
	| "memory-steady"
	| "import"
export interface Case {
	readonly scenario: Scenario
	readonly size: number
	readonly calls: number
}
// Mutable counters are the identical observer used by imperative competitor callbacks.
// They are local to one fixture and never control concurrent lifecycle operations.
export interface Audit {
	activations: number
	finalizers: number
	handlers: number
	terminals: number
	calls: number
	updates: number
	value: number
}
export const audit = (): Audit => ({
	activations: 0,
	finalizers: 0,
	handlers: 0,
	terminals: 0,
	calls: 0,
	updates: 0,
	value: 0,
})
export interface Fixture {
	readonly run: Effect.Effect<number>
	readonly close: Effect.Effect<void>
	readonly read: () => Readonly<Audit>
}
export type Factory = (spec: Case) => Effect.Effect<Fixture>
export const check = (
	condition: boolean,
	message: string,
): Effect.Effect<void> =>
	condition ? Effect.void : Effect.die(new Error(message))
export const eventScenario = (spec: Case) =>
	String.startsWith("events-")(spec.scenario)
export const snapshot = (state: Audit) => () => ({ ...state })
export const supported = (
	implementation: Implementation,
	scenario: Scenario,
): string | undefined => {
	if (scenario === "import") return undefined
	if (implementation === "node" || implementation === "emittery") {
		if (scenario === "events-emit") return undefined
		if (
			implementation === "emittery" &&
			(scenario === "events-parallel" || scenario === "events-sequential")
		)
			return undefined
		return "Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API."
	}
	if (implementation === "avvio") {
		if (scenario === "events-emit") return undefined
		if (scenario === "memory-cycles")
			return "No runtime unload; recreating the entire loader would measure a different lifecycle."
		if (scenario === "fanout-withdraw" || scenario === "fanout-restore")
			return "No runtime plugin unload or dependency reactivation API."
		if (String.startsWith("config-")(scenario))
			return "No runtime plugin configuration update or restart API."
		if (String.startsWith("events-")(scenario))
			return "Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap."
	}
	return undefined
}
