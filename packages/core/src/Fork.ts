/**
 * A fork is one loaded instance of a plugin. Loading the same plugin twice
 * yields two independent forks.
 */
import { Data, Schema, type Cause, type Effect, type Stream } from "effect"

export type ForkState<E = unknown> = Data.TaggedEnum<{
	/** Decoding configuration or running `apply`. */
	Loading: {}
	/** Waiting for required services that are not provided yet. */
	Pending: { readonly missing: ReadonlyArray<string> }
	Active: {}
	/** Startup or execution failed; the fork waits for recovery. */
	Failed: { readonly cause: Cause.Cause<E> }
	Disposed: {}
}>

export const ForkState = Data.taggedEnum<ForkState>()

/** A disposal failure retains the original typed errors, defects, and interruption reasons. */
export class CleanupError extends Schema.TaggedError<
	CleanupError,
	{ readonly brand: unique symbol }
>()("CleanupError", {
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {
	override get message() {
		return "Plugin cleanup failed"
	}
}

/** A probe was unavailable, duplicated, or failed; failures retain their complete cause. */
export class ProbeError extends Schema.TaggedError<
	ProbeError,
	{ readonly brand: unique symbol }
>()("ProbeError", {
	probe: Schema.String,
	reason: Schema.Literals(["Missing", "Duplicate", "Failed", "Unavailable"]),
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}

export interface Fork<in Input = any, out E = any> {
	/** Stable embedded fork identity. */
	readonly id: number
	/** Names registered by the current serving attempt. */
	readonly probes: Effect.Effect<ReadonlyArray<string>>
	/** Runs a registered check in its own scope without restarting the fork on failure. */
	readonly probe: (name: string) => Effect.Effect<void, ProbeError>
	/** The current state followed by every change, ending with `Disposed`. */
	readonly state: Stream.Stream<ForkState<E | Schema.SchemaError>>
	/**
	 * Waits until the fork settles. Fails with the plugin's cause if it ends
	 * up `Failed`; a `Pending` fork counts as settled.
	 */
	readonly await: Effect.Effect<void, E | Schema.SchemaError>
	/**
	 * Waits until this fork and its descendants have no Loading states.
	 * Pending and Failed count as settled; failures are observed through state or await.
	 * This is a current-state barrier, not a barrier for queued configuration requests.
	 */
	readonly stable: Effect.Effect<void>
	/**
	 * Requests the latest configuration. Concurrent requests may skip intermediate inputs.
	 * Completes when handled or superseded, including when this input was never applied.
	 * Does not wait for a restart to finish; use await or state to observe settlement.
	 */
	readonly update: (input: Input) => Effect.Effect<void>
	/** Restarts the plugin even if nothing changed. */
	readonly restart: Effect.Effect<void>
	/** Unloads the plugin and descendants; callers share the complete cleanup result, including failures. */
	readonly dispose: Effect.Effect<void, CleanupError>
}

/** A snapshot of the fork tree. */
export interface ForkTree {
	readonly id: number
	readonly name: string
	readonly input: unknown
	readonly state: ForkState
	readonly children: ReadonlyArray<ForkTree>
}
