import {
	Context,
	HashMap,
	HashSet,
	Option,
	type Cause,
	type LogLevel,
	type PubSub,
	type Scope,
	type TxRef,
	type TxSubscriptionRef,
} from "effect"

import type { MountState } from "../Mount"
import type { Definition } from "./definition"
import type { Group } from "./tasks"

/** Length-prefixed encoding keeps realm and service identities unambiguous. */
export type ServiceKey = string

/** A retained directory entry. Empty slots remain reachable while any operation holds them. */
export interface Slot {
	readonly key: ServiceKey
	readonly provision: TxRef.TxRef<Option.Option<Provision>>
	readonly holders: TxRef.TxRef<number>
}

/** A mount's topology remains visible through withdrawal until its leases are released. */
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

/** One build of a mount, from dependency acquisition to teardown. */
export interface Activation {
	readonly status: MountStatus | undefined
	readonly mount: number
	readonly node: GraphNode
	readonly tasks: Option.Option<Group>
	/** Context keys supplied by this activation's resolved provisions, never inherited by children. */
	readonly provisionKeys: HashSet.HashSet<string>
	/** The inherited fallback before provisions shadow it, including reference intercepts. */
	readonly fallback: Context.Context<never>
	/** What the activation published; `None` once teardown has closed it to publishing. */
	readonly published: TxRef.TxRef<Option.Option<ReadonlyArray<Provision>>>
	/**
	 * The scope of this build. Mounts registered on its behalf, such as a
	 * `Graft.publish` from a background fiber, are torn down with it.
	 */
	readonly scope: Scope.Scope
}

/** Transactional dependency snapshot retained until all leases are released. */
export interface ActiveResolution {
	readonly watch: HashMap.HashMap<ServiceKey, Slot>
	readonly provisions: ReadonlyArray<Provision>
}

export interface Spec {
	readonly definition: Definition
	readonly input: unknown
	readonly revision: number
}

/** A mount's own state, independently observable from the display tree. */
export interface LocalSnapshot<out E = unknown> {
	readonly state: MountState<E>
	readonly accepted: Spec | undefined
	readonly name: string
	readonly input: unknown
	readonly disposed: boolean
}

/** Loading counts include the mount itself and its live descendants. */
export interface MountStatus {
	readonly snapshot: TxSubscriptionRef.TxSubscriptionRef<LocalSnapshot>
	readonly loading: TxRef.TxRef<number>
	readonly parent: MountStatus | undefined
}

export interface MountEntry<out E = unknown> {
	readonly status: MountStatus
	readonly id: number
	readonly node: GraphNode
	readonly parent: number | undefined
	readonly spec: TxRef.TxRef<Spec>
	/** The spec the supervisor last acted on; `Publication.set` waits for it to catch up. */
	readonly accepted: Spec | undefined
	readonly name: string
	readonly input: unknown
	readonly state: MountState<E>
}

export interface LogEntry {
	readonly date: Date
	readonly level: LogLevel.LogLevel
	readonly message: unknown
	readonly cause: Cause.Cause<unknown>
	readonly annotations: Readonly<Record<string, unknown>>
}

export interface Runtime {
	/** Services from the environment `Graft.layer` was built in; they satisfy `requires` too. */
	readonly ambient: Context.Context<never>
	readonly slots: TxRef.TxRef<HashMap.HashMap<ServiceKey, Slot>>
	readonly mounts: TxSubscriptionRef.TxSubscriptionRef<
		HashMap.HashMap<number, MountEntry>
	>
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
