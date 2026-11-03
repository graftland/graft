/**
 * A fork is one loaded instance of a plugin. Loading the same plugin twice
 * yields two independent forks.
 */
import type { Cause, Effect, Schema, Stream } from "effect"
import { Data } from "effect"

export type ForkState = Data.TaggedEnum<{
	/** Decoding configuration or running `apply`. */
	Loading: {}
	/** Waiting for required services that are not provided yet. */
	Pending: { readonly missing: ReadonlyArray<string> }
	Active: {}
	/** `apply` failed; the fork waits for a change or its retry schedule. */
	Failed: { readonly cause: Cause.Cause<unknown> }
	Disposed: {}
}>

export const ForkState = Data.taggedEnum<ForkState>()

export interface Fork<in Input = any, out E = any> {
	readonly id: number
	/** The current state followed by every change, ending with `Disposed`. */
	readonly state: Stream.Stream<ForkState>
	/**
	 * Waits until the fork settles. Fails with the plugin's cause if it ends
	 * up `Failed`; a `Pending` fork counts as settled.
	 */
	readonly await: Effect.Effect<void, E | Schema.SchemaError>
	/** Replaces the configuration; the plugin updates in place or restarts. */
	readonly update: (input: Input) => Effect.Effect<void>
	/** Restarts the plugin even if nothing changed. */
	readonly restart: Effect.Effect<void>
	/** Unloads the plugin and everything it loaded. */
	readonly dispose: Effect.Effect<void>
}

/** A snapshot of the fork tree. */
export interface ForkTree {
	readonly id: number
	readonly name: string
	readonly input: unknown
	readonly state: ForkState
	readonly children: ReadonlyArray<ForkTree>
}
