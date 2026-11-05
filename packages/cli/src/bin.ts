#!/usr/bin/env node
/**
 * The `graft` executable. Running this module starts the program.
 */
import { Array, Effect, Layer, Logger, Option, Stdio } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { NodeRuntime } from "@effect/platform-node"

import { command as create } from "@graftland/create/Command"
import { Graft } from "@graftland/graft"

import { version } from "../package.json" with { type: "json" }
import { platform } from "./Application"
import * as Host from "./internal/commandHost"

const start = Command.make(
	"start",
	{
		config: Argument.String("config").pipe(
			Argument.withDescription("Path of the config file"),
			Argument.withDefault("graft.yml"),
		),
		watch: Flag.Boolean("watch").pipe(
			Flag.withAlias("w"),
			Flag.withDescription("Reload plugins and config when files change"),
			Flag.withDefault(false),
		),
		envFile: Flag.String("env-file").pipe(
			Flag.withDescription(
				"Read variables for !env from a .env file; the process environment takes precedence",
			),
			Flag.optional,
		),
	},
	(options) =>
		Effect.promise(() => import("./Start")).pipe(
			Effect.uninterruptible,
			Effect.flatMap((Start) =>
				Start.run({
					...options,
					envFile: Option.getOrUndefined(options.envFile),
				}),
			),
		),
).pipe(
	Command.withDescription("Run the application described by a config file"),
)

const add = Command.make(
	"add",
	{
		packages: Argument.variadic(Argument.String("package")),
		plugin: Flag.String("plugin").pipe(Flag.optional),
		global: Flag.Boolean("global").pipe(Flag.withDefault(false)),
	},
	Effect.fnUntraced(function* ({ packages, plugin, global }) {
		if (
			(global && Option.isNone(plugin)) ||
			(Option.isSome(plugin) && packages.length > 0)
		)
			return yield* CliError.UserError.make({
				cause: "Conflicting install options",
				userMessage:
					"Use add --plugin <name> [--global] without package arguments",
			})
		const Manage = yield* Effect.promise(() => import("./Manage")).pipe(
			Effect.uninterruptible,
		)
		return yield* Option.isSome(plugin)
			? Manage.addPlugin(plugin.value, global)
			: Manage.add(packages)
	}),
).pipe(
	Command.withDescription(
		"Add dependencies, restoring the project if installing fails",
	),
)

const remove = Command.make(
	"remove",
	{ packages: Argument.variadic(Argument.String("package")) },
	({ packages }) =>
		Effect.promise(() => import("./Manage")).pipe(
			Effect.uninterruptible,
			Effect.flatMap((Manage) => Manage.remove(packages)),
		),
).pipe(
	Command.withDescription(
		"Remove dependencies, restoring the project if installing fails",
	),
)

const graft = Command.make("graft").pipe(
	Command.withDescription("Run and manage Graft applications"),
	Command.withSharedFlags({
		stdio: Flag.Boolean("stdio").pipe(Flag.withDefault(false)),
		noPlugins: Flag.Boolean("no-plugins").pipe(Flag.withDefault(false)),
	}),
)

const program = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	const args = yield* stdio.args
	return yield* Host.output(
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(Graft.layer)
				return yield* Host.run(
					[start, create, add, remove],
					graft,
					version,
					args,
				).pipe(Effect.provideContext(context))
			}),
		),
		args,
	)
})
NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(platform)
			return yield* program.pipe(Effect.provideContext(context))
		}),
	).pipe(
		(effect) =>
			Effect.withFiber((main) =>
				effect.pipe(
					Effect.tapCause((cause) =>
						Array.every(
							cause.reasons,
							(reason) =>
								reason._tag === "Interrupt" && reason.fiberId === main.id,
						) ||
						Array.every(
							cause.reasons,
							(reason) =>
								reason._tag === "Fail" && CliError.isCliError(reason.error),
						)
							? Effect.void
							: Effect.logError(cause),
					),
				),
			),
		Effect.provideService(Logger.LogToStderr, true),
	),
	{ disableErrorReporting: true },
)
