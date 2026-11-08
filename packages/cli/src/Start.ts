/**
 * Runs a Graft application from its config file. The host process runs only
 * the kernel; the Loader and every entry run in units.
 */
import { fileURLToPath } from "node:url"

import {
	Cause,
	Effect,
	FileSystem,
	Layer,
	Logger,
	Option,
	Path,
	Stdio,
	type PlatformError,
} from "effect"
import { NodeServices } from "@effect/platform-node"

import { Kernel } from "@graftland/graft"
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import { ApplicationError, ProtocolOutput } from "./Application"

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

/** The Loader may wait for every entry to be inspected and deployed. */
const loaderBudget = {
	total: 600_000,
	startup: 240_000,
	probe: 5_000,
	drain: 5_000,
	stop: 10_000,
	terminate: 10_000,
}

/** The nearest directory with a package.json at or above a module file. */
const packageOf = (
	file: string,
): Effect.Effect<
	string,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = path.dirname(file)
		if (yield* fs.exists(path.join(directory, "package.json"))) return directory
		if (path.dirname(directory) === directory)
			return yield* Effect.die("No package.json above the module")
		return yield* packageOf(directory)
	})
/** Captures a built module's package beside its own dependencies, without importing it. */
const packaged = Effect.fnUntraced(function* (module: URL) {
	const path = yield* Path.Path
	const file = fileURLToPath(module)
	const directory = yield* packageOf(file)
	return yield* Artifact.capture({
		directory,
		entry: path.relative(directory, file),
		store: path.join(directory, ".cache", "units"),
		exclude: ["node_modules", ".cache", ".graft", "src", "test"],
	})
})
const resolved = (specifier: string) =>
	Effect.try({
		try: () => new URL(import.meta.resolve(specifier)),
		catch: (cause) => ApplicationError.make({ cause: Cause.fail(cause) }),
	})

const application = Effect.fnUntraced(function* (options: Options) {
	const path = yield* Path.Path
	const file = path.resolve(options.config)
	const kernel = yield* Kernel.Kernel
	const address = yield* Control.serve()
	const deployment = yield* resolved("@graftland/loader/Deployment")
	const loader = yield* packaged(deployment)
	const environment = yield* packaged(
		new URL("./Environment.js", import.meta.url),
	)
	const target = Units.target({
		artifact: loader,
		placement: "Worker",
		input: { config: file, control: address },
		environment: [
			{
				artifact: environment,
				export: "default",
				options: {
					...(options.envFile === undefined
						? {}
						: { file: path.resolve(options.envFile) }),
					...(options.envDir === undefined
						? {}
						: { dir: path.resolve(options.envDir) }),
				},
			},
		],
	})
	const handle = yield* kernel.submit({
		operations: [{ _tag: "Deploy", instance: "loader", target }],
		budget: loaderBudget,
	})
	const conclusion = yield* handle.await
	if (conclusion.outcome !== "Accepted")
		return yield* ApplicationError.make({ cause: conclusion.cause })
	yield* Effect.logInfo(`Running ${path.relative(process.cwd(), file) || file}`)
	/** With protocol stdio, the process ends once the holder ends its output. */
	const bridge = yield* Units.StdioBridge
	if (Option.isNone(bridge)) return yield* Effect.never
	return yield* bridge.value.closed.pipe(
		Effect.catchCause((cause) => ApplicationError.make({ cause })),
	)
})

/** The kernel; with protocol stdio, also the bridge that lends the reserved stdio to a unit. */
const kernel = (protocol: Option.Option<Stdio.Stdio>) =>
	Kernel.layer({
		authority: "graft-start",
		maxUnits: 64,
		instances: [],
	}).pipe(
		Layer.provide(Units.layer),
		Layer.provideMerge(
			Option.match(protocol, {
				onNone: () => Layer.empty,
				onSome: (stdio) =>
					Units.stdio.pipe(Layer.provide(Layer.succeed(Stdio.Stdio, stdio))),
			}),
		),
		Layer.provideMerge(NodeServices.layer),
		Layer.provideMerge(Logger.layer([Logger.consolePretty()])),
	)

/**
 * Loads one configuration revision through the Loader unit. Watch and live
 * Loader mutation are rejected for this deployment.
 */
export const run = (
	options: Options,
): Effect.Effect<
	void,
	ApplicationError | PlatformError.PlatformError,
	Stdio.Stdio
> =>
	options.watch
		? ApplicationError.make({
				cause: Cause.fail(
					"Watch and live Loader mutation are unsupported for this deployment",
				),
			})
		: Effect.gen(function* () {
				const protocol = yield* ProtocolOutput
				const stdio = yield* Stdio.Stdio
				return yield* application(options).pipe(
					Effect.scoped,
					Effect.catchTags({
						ArtifactError: (error) =>
							ApplicationError.make({ cause: Cause.fail(error) }),
						ChangeRejected: (error) =>
							ApplicationError.make({ cause: Cause.fail(error) }),
						ControlError: (error) =>
							ApplicationError.make({ cause: Cause.fail(error) }),
					}),
					// @effect-diagnostics-next-line strictEffectProvide:off -- this runs the whole application, so it is an entry point
					Effect.provide(kernel(protocol ? Option.some(stdio) : Option.none())),
				)
			})
