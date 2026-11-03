import type {
	Cause,
	Effect,
	FiberSet,
	LogLevel,
	PubSub,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { Context, HashMap, HashSet, Option } from "effect"
import type { ForkState } from "../Fork"
import type { Plugin } from "../Plugin"

/** A service value published into one realm by one activation. */
export interface Provision {
	readonly key: string
	readonly service: string
	readonly value: unknown
	readonly leases: TxRef.TxRef<number>
}

/** One run of a plugin's `apply`, from dependency acquisition to teardown. */
export interface Activation {
	readonly fork: number
	/** What the activation published; `None` once teardown has closed it to publishing. */
	readonly published: TxRef.TxRef<Option.Option<ReadonlyArray<Provision>>>
}

export interface Spec {
	readonly plugin: Plugin
	readonly input: unknown
	readonly revision: number
}

export interface ForkEntry {
	readonly id: number
	readonly parent: number | undefined
	readonly spec: TxRef.TxRef<Spec>
	/** The spec the supervisor last acted on; `Fork.update` waits for it to catch up. */
	readonly accepted: Spec | undefined
	readonly name: string
	readonly input: unknown
	readonly state: ForkState
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
	readonly run: (args: Args) => Effect.Effect<Out, E>
}

export interface Runtime {
	/** Services from the environment `Graft.layer` was built in; they satisfy `inject` too. */
	readonly ambient: Context.Context<never>
	readonly registry: TxRef.TxRef<HashMap.HashMap<string, Provision>>
	readonly forks: TxSubscriptionRef.TxSubscriptionRef<
		HashMap.HashMap<number, ForkEntry>
	>
	readonly aliases: TxRef.TxRef<HashMap.HashMap<Plugin, Plugin>>
	/** Every service key ever published; these are never inherited, only resolved. */
	readonly dynamic: TxRef.TxRef<HashSet.HashSet<string>>
	readonly events: TxRef.TxRef<HashMap.HashMap<string, ReadonlyArray<Handler>>>
	readonly ids: TxRef.TxRef<number>
	readonly logs: PubSub.PubSub<LogEntry>
}

/** Maps a service key to the realm it resolves in. Absent keys use the root realm. */
export const Realms = Context.Reference<HashMap.HashMap<string, string>>(
	"@nmnmcc/graft/Realms",
	{
		defaultValue: () => HashMap.empty(),
	},
)

/** The realm a key resolves in; the root realm is the empty string. */
export const realmOf = (
	realms: HashMap.HashMap<string, string>,
	key: string,
): string => Option.getOrElse(HashMap.get(realms, key), () => "")

export const realmKey = (
	realms: HashMap.HashMap<string, string>,
	service: string,
): string => `${realmOf(realms, service)}\u0000${service}`
