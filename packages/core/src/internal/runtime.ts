import {
	Context,
	HashMap,
	HashSet,
	Option,
	type Cause,
	type Deferred,
	type Effect,
	type FiberSet,
	type LogLevel,
	type PubSub,
	type Scope,
	type TxPubSub,
	type TxRef,
	type TxSubscriptionRef,
} from "effect"

import type { ForkState } from "../Fork"
import type { Plugin } from "../Plugin"
import type { Aliases } from "./aliases"
import type { Group } from "./tasks"

/** Length-prefixed encoding keeps realm and service identities unambiguous. */
export type ServiceKey = string

/** A retained directory entry. Empty slots remain reachable while any operation holds them. */
export interface Slot {
	readonly key: ServiceKey
	readonly provision: TxRef.TxRef<Option.Option<Provision>>
	readonly holders: TxRef.TxRef<number>
}

/** A fork's topology remains visible through withdrawal until its leases are released. */
export interface GraphNode {
	readonly id: number
	readonly parent: GraphNode | undefined
	readonly state: TxRef.TxRef<{
		readonly live: boolean
		readonly resolution: ActiveResolution | undefined
	}>
}

/** A service value published into one realm by one activation. */
export interface Provision {
	readonly key: ServiceKey
	readonly service: string
	readonly value: unknown
	readonly owner: number
	readonly node: GraphNode
	readonly slot: Slot
	readonly consumers: TxRef.TxRef<HashSet.HashSet<number>>
}

/** One run of a plugin's `apply`, from dependency acquisition to teardown. */
export interface Activation {
	readonly status: ForkStatus | undefined
	readonly fork: number
	readonly node: GraphNode
	readonly tasks: Option.Option<Group>
	/** Context keys supplied by this activation's resolved provisions, never inherited by children. */
	readonly provisionKeys: HashSet.HashSet<string>
	/** The inherited fallback before provisions shadow it, including reference intercepts. */
	readonly fallback: Context.Context<never>
	/** What the activation published; `None` once teardown has closed it to publishing. */
	readonly published: TxRef.TxRef<Option.Option<ReadonlyArray<Provision>>>
}

/** Transactional dependency snapshot retained until all leases are released. */
export interface ActiveResolution {
	readonly watch: HashMap.HashMap<ServiceKey, Slot>
	readonly provisions: ReadonlyArray<Provision>
}

export interface Spec {
	readonly plugin: Plugin
	/** The plugin the fork was loaded with, before aliases; a rollback resolves it again. */
	readonly requested: Plugin
	readonly input: unknown
	readonly revision: number
}

/** A fork's own state, independently observable from the display tree. */
export interface LocalSnapshot<out E = unknown> {
	readonly state: ForkState<E>
	readonly accepted: Spec | undefined
	readonly name: string
	readonly input: unknown
	readonly disposed: boolean
}

/** Loading counts include the fork itself and its live descendants. */
export interface ForkStatus {
	readonly snapshot: TxSubscriptionRef.TxSubscriptionRef<LocalSnapshot>
	readonly probes: import("./probes").Registry
	readonly managed: TxRef.TxRef<Option.Option<import("./transition").Managed>>
	readonly generationEvents: TxPubSub.TxPubSub<
		import("../Transition").GenerationEvent
	>
	readonly generations: TxSubscriptionRef.TxSubscriptionRef<
		ReadonlyArray<import("../Transition").Generation>
	>
	readonly loading: TxRef.TxRef<number>
	readonly parent: ForkStatus | undefined
}

export interface ForkEntry<out E = unknown> {
	readonly scope: Scope.Closeable
	readonly status: ForkStatus
	readonly id: number
	readonly node: GraphNode
	readonly parent: number | undefined
	readonly spec: TxRef.TxRef<Spec>
	/** The spec the supervisor last acted on; `Fork.update` waits for it to catch up. */
	readonly accepted: Spec | undefined
	readonly name: string
	readonly input: unknown
	readonly state: ForkState<E>
}

export interface LogEntry {
	readonly date: Date
	readonly level: LogLevel.LogLevel
	readonly message: unknown
	readonly cause: Cause.Cause<unknown>
	readonly annotations: Readonly<Record<string, unknown>>
}

/** One registered event handler, running with the context of the code that registered it. */
export interface Handler<
	in Args extends ReadonlyArray<unknown> = any,
	out Out = any,
	out E = any,
> {
	readonly realm: string
	readonly order: number
	readonly global: boolean
	readonly once: boolean
	readonly context: Context.Context<never>
	readonly fibers: FiberSet.FiberSet<Out, E>
	/** Detaches from its owner after a claimed once invocation finishes, including cancellation cleanup. */
	readonly scope: Scope.Closeable
	/** Identifies the owner closer so normal dispatch can distinguish withdrawal from self-interruption. */
	readonly closing: Deferred.Deferred<number>
	readonly run: (args: Args) => Effect.Effect<Out, E>
}

export interface Runtime {
	readonly mutations: TxRef.TxRef<number>
	readonly transitionBusy: TxRef.TxRef<boolean>
	readonly transitionStuck: TxRef.TxRef<boolean>
	/** Services from the environment `Graft.layer` was built in; they satisfy `inject` too. */
	readonly ambient: Context.Context<never>
	readonly slots: TxRef.TxRef<HashMap.HashMap<ServiceKey, Slot>>
	readonly forks: TxSubscriptionRef.TxSubscriptionRef<
		HashMap.HashMap<number, ForkEntry>
	>
	readonly aliases: Aliases
	readonly events: TxRef.TxRef<HashMap.HashMap<string, ReadonlyArray<Handler>>>
	readonly ids: TxRef.TxRef<number>
	readonly logs: PubSub.PubSub<LogEntry>
}

/** Maps a service key to the realm it resolves in. Absent keys use the root realm. */
export const Realms = Context.Reference<HashMap.HashMap<string, string>>(
	"@graftland/graft/Realms",
	{
		defaultValue: () => HashMap.empty(),
	},
)

/** The realm a key resolves in; the root realm is the empty string. */
export const realmOf = (
	realms: HashMap.HashMap<string, string>,
	key: string,
): string => Option.getOrElse(HashMap.get(realms, key), () => "")

/** The single constructor used by publication, resolution, and failed-publication retries. */
export const realmKey = (realm: string, service: string): ServiceKey =>
	`${realm.length}:${realm}${service}`

/** Both public and private context views address this same runtime value. */
export const GraftKey = "@graftland/graft/Graft"
