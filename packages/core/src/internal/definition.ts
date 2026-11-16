import { Data, type Context, type Effect, type Schedule } from "effect"

/**
 * Marks a requirement as optional: the mount builds without it and rebuilds
 * whenever it appears or disappears.
 */
export class Optional<
	out Key extends Context.Key<any, any>,
> extends Data.TaggedClass("Optional")<{ readonly key: Key }> {}

export type Dependency = Context.Key<any, any> | Optional<Context.Key<any, any>>

export const isOptional = (
	dependency: Dependency,
): dependency is Optional<Context.Key<any, any>> =>
	"_tag" in dependency && dependency._tag === "Optional"

/** What the supervisor runs for one mount: a layer, or a published value. */
export interface Definition {
	readonly name: string
	readonly requires: ReadonlyArray<Dependency>
	readonly retry: Schedule.Schedule<unknown, unknown> | undefined
	/** Runs only inside an activation, which provides whatever it needs. */
	readonly apply: (input: unknown) => Effect.Effect<void, unknown, unknown>
}
