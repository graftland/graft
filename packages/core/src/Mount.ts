/**
 * A mount is one layer placed in the graph. Mounting the same layer twice
 * yields two independent mounts.
 */
import { Data, Schema, type Cause, type Effect, type Stream } from "effect"

export type MountState<E = unknown> = Data.TaggedEnum<{
	/** Building the layer. */
	Loading: {}
	/** Waiting for required services that are not available yet. */
	Pending: { readonly missing: ReadonlyArray<string> }
	/** Built; its services are published. */
	Active: {}
	/** Building or a background fiber failed; the mount waits for a change or its retry schedule. */
	Failed: { readonly cause: Cause.Cause<E> }
	Unmounted: {}
}>

export const MountState = Data.taggedEnum<MountState>()

/** An unmount failure retains the original typed errors, defects, and interruption reasons. */
export class CleanupError extends Schema.TaggedError<
	CleanupError,
	{ readonly brand: unique symbol }
>()("CleanupError", {
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {
	override get message() {
		return "Releasing the mount failed"
	}
}

export interface Mount<out E = any> {
	readonly id: number
	/** The current state followed by every change, ending with `Unmounted`. */
	readonly state: Stream.Stream<MountState<E>>
	/**
	 * Waits until the mount settles. Fails with the build's cause if it ends
	 * up `Failed`; a `Pending` mount counts as settled.
	 */
	readonly await: Effect.Effect<void, E>
	/**
	 * Waits until this mount and the mounts below it have no Loading states.
	 * Pending and Failed count as settled; failures are observed through state or await.
	 */
	readonly stable: Effect.Effect<void>
	/** Tears the layer down and builds it again, even if nothing changed. */
	readonly restart: Effect.Effect<void>
	/** Tears the layer down and removes it, with the mounts below it; callers share the complete cleanup result. */
	readonly unmount: Effect.Effect<void, CleanupError>
}

/** A value placed in the graph with `Graft.publish`. */
export interface Publication<in S, out E = any> extends Mount<E> {
	/**
	 * Replaces the value. Everything that requires it is rebuilt with the new
	 * one. Completes when the change is accepted, not when rebuilding ends;
	 * concurrent calls may skip intermediate values.
	 */
	readonly set: (value: S) => Effect.Effect<void>
}

/** A snapshot of the mount tree. */
export interface MountTree {
	readonly id: number
	readonly name: string
	readonly state: MountState
	readonly children: ReadonlyArray<MountTree>
}
