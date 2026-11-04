import { Context, Deferred, Effect, Exit, Option, Schema, Scope } from "effect"
import * as Release from "@graftland/graft/Release"
import type { TransportError } from "../Errors"

export class StartupError extends Schema.TaggedError<
	StartupError,
	{ readonly brand: unique symbol }
>()("RunnerStartupError", {
	detail: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Defect())),
}) {
	override get message() {
		return this.detail
	}
}

export class RunnerLifecycle extends Context.Service<
	RunnerLifecycle,
	{
		readonly ended: Deferred.Deferred<void, TransportError>
		readonly released: Deferred.Deferred<void, StartupError>
	}
>()("@graftland/plugin-remote/internal/RunnerLifecycle") {}

export const make = Effect.all({
	ended: Deferred.make<void, TransportError>(),
	released: Deferred.make<void, StartupError>(),
})

/** Observe shutdown independently of the loader, which logs child cleanup failures. */
export const resources = Effect.fnUntraced(function* (
	lifecycle: Option.Option<typeof RunnerLifecycle.Service>,
) {
	return yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
		Release.close(scope, exit).pipe(
			Effect.onExit((released) =>
				Option.isNone(lifecycle)
					? Effect.void
					: Deferred.done(
							lifecycle.value.released,
							Exit.isSuccess(released)
								? Exit.void
								: Exit.fail(
										StartupError.make({
											detail: "Supervisor shutdown failed",
											cause: released.cause,
										}),
									),
						).pipe(Effect.asVoid),
			),
		),
	)
})
