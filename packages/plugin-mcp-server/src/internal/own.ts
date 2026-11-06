import {
	Array,
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	References,
	Scope,
	Tracer,
} from "effect"
import { McpSchema, type McpServer } from "effect/ai"

import { Base } from "./base"

/** Services supplied by Effect for each invocation, rather than injected by a contributor. */
export type RequestServices =
	| McpSchema.McpRequestContext
	| McpSchema.McpServerClient
	| McpServer.McpServer
	| Scope.Scope

/** Captures the plugin context and owns each invocation until its cleanup finishes. */
export const own = <Args extends ReadonlyArray<unknown>, A, E, R>(
	handler: (...args: Args) => Effect.Effect<A, E, R>,
): Effect.Effect<
	(...args: Args) => Effect.Effect<A, E>,
	never,
	Exclude<R, RequestServices> | Scope.Scope
> =>
	Effect.gen(function* () {
		const captured = yield* Effect.context<Exclude<R, RequestServices>>()
		const plugin: Context.Context<never> = (
			captured as Context.Context<never>
		).pipe(
			Context.omit(Scope.Scope, References.CurrentLogLevel, Tracer.ParentSpan),
		)
		const calls = yield* FiberSet.make<A, E>()
		return (...args: Args) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const request = yield* Effect.context<never>()
					const base = Context.get(request, Base)
					// Context's public representation is a Map; compare values by identity, as Effect does.
					const additions = new Map(
						Array.filter(
							[...request.mapUnsafe],
							([key, value]) =>
								!base.mapUnsafe.has(key) || base.mapUnsafe.get(key) !== value,
						),
					)
					const context = Context.add(
						Context.merge(
							Context.merge(request, plugin),
							Context.makeUnsafe<never>(additions),
						),
						References.CurrentLogAnnotations,
						{
							...Context.get(request, References.CurrentLogAnnotations),
							...Context.get(plugin, References.CurrentLogAnnotations),
						},
					)
					const fiber = yield* FiberSet.run(
						calls,
						Effect.updateContext(
							handler(...args),
							(_: Context.Context<never>) => context as Context.Context<R>,
						),
					)
					return yield* restore(Fiber.join(fiber)).pipe(
						Effect.onInterrupt(() =>
							Fiber.interrupt(fiber).pipe(
								Effect.andThen(Fiber.await(fiber)),
								Effect.flatMap((exit) =>
									Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
										? Effect.logError(
												"An MCP handler failed while stopping",
												exit.cause,
											)
										: Effect.void,
								),
							),
						),
					)
				}),
			)
	})
