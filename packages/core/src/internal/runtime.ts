import type {
	Cause,
	Deferred,
	Effect,
	FiberSet,
	LogLevel,
	PubSub,
	Scope,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { Context, Data, HashMap, HashSet, Option } from "effect"
import type { ForkState } from "../Fork"
import type { Plugin } from "../Plugin"
import type { Group } from "./tasks"
import type { PluginIdentity } from "./pluginIdentity"

/** Structural identity keeps realm labels and service keys independent, including embedded separators. */
export class ServiceKey extends Data.Class<{
	readonly realm: string
	readonly service: string
}> {}

/** A service value published into one realm by one activation. */
export interface Provision {
	readonly key: ServiceKey
	readonly service: string
	readonly value: unknown
	readonly owner: number
	readonly consumers: TxRef.TxRef<HashSet.HashSet<number>>
}

/** One run of a plugin's `apply`, from dependency acquisition to teardown. */
export interface Activation {
	readonly fork: number
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
	readonly watch: HashSet.HashSet<ServiceKey>
	readonly provisions: ReadonlyArray<Provision>
}

export interface Spec {
	readonly plugin: Plugin
	readonly input: unknown
	readonly revision: number
}

export interface ForkEntry<out E = unknown> {
	readonly id: number
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
	readonly global: boolean
	readonly once: boolean
	readonly context: Context.Context<never>
	readonly fibers: FiberSet.FiberSet<Out, E>
	/** Detaches from its owner after a claimed once invocation finishes, including cancellation cleanup. */
	readonly scope: Scope.Closeable
	/** Identifies the fiber that closes the handler group and interrupts its invocations. */
	readonly closing: Deferred.Deferred<number>
	readonly run: (args: Args) => Effect.Effect<Out, E>
}

export interface Runtime {
	/** Services from the environment `Graft.layer` was built in; they satisfy `inject` too. */
	readonly ambient: Context.Context<never>
	readonly registry: TxRef.TxRef<HashMap.HashMap<ServiceKey, Provision>>
	readonly active: TxRef.TxRef<HashMap.HashMap<number, ActiveResolution>>
	readonly forks: TxSubscriptionRef.TxSubscriptionRef<
		HashMap.HashMap<number, ForkEntry>
	>
	readonly aliases: TxRef.TxRef<HashMap.HashMap<PluginIdentity, Plugin>>
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
	new ServiceKey({ realm, service })
