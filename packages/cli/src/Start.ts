/**
 * Runs a Graft application from its config file.
 */
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Layer,
	Logger,
	Path,
	Scope,
	Semaphore,
	type PlatformError,
	type Schema,
} from "effect"
import { NodeServices } from "@effect/platform-node"

import { Graft, type Transition } from "@graftland/graft"
import {
	Entry,
	Include,
	Loader,
	ModuleResolver,
	type Tree,
} from "@graftland/loader"

import { Application, ApplicationError, platform } from "./Application"
import { layer as env } from "./internal/env"
import * as Inspection from "./internal/inspection"
import { layer as intercepts } from "./internal/intercepts"

export interface Options {
	/** Path of the config file. */
	readonly config: string
	/** Live editing is unsupported for this deployment. */
	readonly watch: boolean
	/**
	 * A `.env` file that `!env` reads when the process environment does not set
	 * a variable.
	 */
	readonly envFile?: string | undefined
	/**
	 * A directory of secret files that `!env` reads when neither the process
	 * environment nor `envFile` sets a variable. Each regular file is one
	 * variable, named after the file.
	 */
	readonly envDir?: string | undefined
}

/**
 * Loads one configuration revision using inspected module descriptors.
 */
export const run = (
	options: Options,
): Effect.Effect<
	void,
	| ApplicationError
	| Graft.ServiceConflict
	| Transition.ManagedFork
	| PlatformError.BadArgument
	| PlatformError.PlatformError
	| Schema.SchemaError
	| Loader.StoreError
	| Tree.InvalidOperation
> =>
	Effect.gen(function* () {
		if (options.watch)
			return yield* ApplicationError.make({
				cause: Cause.fail(
					"Watch and live Loader mutation are unsupported for this deployment",
				),
			})
		const scope = yield* Effect.scope
		const done = yield* Deferred.make<void, ApplicationError>()
		const protocol = yield* Semaphore.make(1)
		yield* Graft.provide(Application, {
			claimProtocol: Effect.acquireRelease(
				protocol.takeIfAvailable(1).pipe(
					Effect.flatMap((acquired) =>
						acquired
							? Effect.void
							: Effect.fail(
									ApplicationError.make({
										cause: Cause.fail(
											"Only one runner may own the process stdio channel",
										),
									}),
								),
					),
				),
				() => protocol.release(1),
			),
			finish: (exit) =>
				Deferred.done(
					done,
					Exit.isFailure(exit)
						? Exit.fail(ApplicationError.make({ cause: exit.cause }))
						: Exit.void,
				).pipe(Effect.asVoid),
			onExit: (release) => Scope.addFinalizer(scope, release),
		})
		const path = yield* Path.Path
		const file = path.resolve(options.config)
		const directory = path.dirname(file)
		const control = yield* Inspection.Address
		const resolver = yield* ModuleResolver.make({
			base: directory,
			control,
		}).pipe(
			Effect.mapError((error) =>
				ApplicationError.make({ cause: Cause.fail(error) }),
			),
		)
		yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
		const included = yield* Graft.plugin(Include.Include, {
			path: file,
			watch: false,
		})
		yield* included.await

		yield* Effect.logInfo(
			`Running ${path.relative(process.cwd(), file) || file}`,
		)
		return yield* Deferred.await(done)
	}).pipe(
		Effect.scoped,
		Effect.provideService(Entry.Select, (entry) => entry["cli"] !== true),
		// @effect-diagnostics-next-line strictEffectProvide:off -- this runs the whole application, so it is an entry point
		Effect.provide(
			Layer.provideMerge(
				Graft.layer,
				Layer.mergeAll(
					platform,
					Inspection.layer,
					intercepts,
					env({ file: options.envFile, dir: options.envDir }).pipe(
						Layer.provide(NodeServices.layer),
					),
					Logger.layer([Logger.consolePretty()]),
				),
			),
		),
		Effect.catchTag("ControlError", (error) =>
			ApplicationError.make({ cause: Cause.fail(error) }),
		),
	)
